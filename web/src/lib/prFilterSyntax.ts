// The text form of a LaneFilter, for the box above the board and for agents.
//
//   word  "a phrase"  /regex/        title or branch contains / matches
//   #322  ORBIT-1042                  number / tracker card
//   author:ana  label:"needs work"  review:approved  base:main   any facet, a,b = either
//   is:conflict  ci:failing|passing|running  updated:>14d  updated:<2d
//   has:card                          the field is set
//   (a | b c)                         a group: `|` makes it "or", else "and"
//
// A leading `-` hides what matches (lane "hide"). `!` keeps what does NOT match
// (lane "show", op `not`/`unset`); `-!` hides what does not match. Inside a
// group there are no lanes, so `-` and `!` both mean "not" and only work on
// facets, not on words.
//
// Round trip: lanesToText then parseRuleText gives the same PRs kept. Shapes
// may move between lanes (a show `not` and a hide `is` read the same).
//
// Ceilings: a value cannot hold both quote characters; `updated:` counts days
// only; a word with `(`, `)` or `:` in it must be quoted.
import {
  VIEW_LIMITS, isGroup, validateLaneFilter,
  type FilterGroup, type FilterNode, type FilterOp, type FilterRule, type LaneFilter,
} from "../../../shared/prFilter.ts";
import type { PrSummary } from "../../../shared/types.ts";
import { FACETS, EXTRA_FIELD_KEYS } from "./prFilter.ts";

export type Lane = "show" | "hide";
export type ParseCtx = { newId?: () => string };
export type ParseResult = { add: { lane: Lane; node: FilterNode }[] } | { error: string };

const CI: Record<string, string> = { failing: "red", passing: "green", running: "pending" };
const CI_BACK: Record<string, string> = { red: "failing", green: "passing", pending: "running" };
const FIELDS = new Set<string>([...FACETS.map((f) => f.queryKey), ...EXTRA_FIELD_KEYS]);
const FLIP: Partial<Record<FilterOp, FilterOp>> = { is: "not", not: "is", set: "unset", unset: "set" };
const CARD_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

class Fail extends Error {}
const fail = (m: string): never => { throw new Fail(m); };

let seq = 0;
const defaultId = () => `t${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

type Item = { neg: boolean; bang: boolean; node: FilterNode };

class Reader {
  i = 0;
  constructor(readonly s: string, readonly newId: () => string) {}
  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++; }
  peek() { return this.s[this.i]; }

  /** Items up to `)` or the end, split on `|`. */
  alternatives(depth: number): Item[][] {
    const alts: Item[][] = [[]];
    for (;;) {
      this.ws();
      const c = this.peek();
      if (c === undefined || c === ")") return alts;
      if (c === "|") { this.i++; alts.push([]); continue; }
      alts[alts.length - 1]!.push(this.item(depth));
    }
  }

  item(depth: number): Item {
    let neg = false, bang = false;
    for (;;) {
      const c = this.peek();
      if (c === "-" && !neg) neg = true;
      else if (c === "!" && !bang) bang = true;
      else break;
      this.i++;
    }
    if (this.peek() === "(") {
      if (depth >= VIEW_LIMITS.depth) fail(`groups nest at most ${VIEW_LIMITS.depth} deep`);
      this.i++;
      const alts = this.alternatives(depth + 1);
      if (this.peek() !== ")") fail("a ( has no closing )");
      this.i++;
      return { neg, bang, node: this.group(alts) };
    }
    return { neg, bang, node: this.term() };
  }

  /** `(a b)` is an AND group; `(a | b c)` an OR group whose second alternative is an AND group. */
  group(alts: Item[][]): FilterGroup {
    const nodes = alts.map((alt) => alt.map(inGroup));
    if (nodes.some((n) => !n.length)) fail("empty group or alternative");
    if (nodes.length === 1) return { id: this.newId(), kind: "group", join: "and", children: nodes[0]! };
    const children = nodes.map((n) => (n.length === 1 ? n[0]! : { id: this.newId(), kind: "group" as const, join: "and" as const, children: n }));
    return { id: this.newId(), kind: "group", join: "or", children };
  }

  /** One bare token's raw text; quotes and /regex/ keep their delimiters. */
  raw(): string {
    const start = this.i;
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (/\s/.test(c) || c === ")") break;
      if (c === '"' || c === "'") {
        const end = this.s.indexOf(c, this.i + 1);
        if (end < 0) fail("a quote is not closed");
        this.i = end + 1;
      } else if (c === "/" && this.i === start) {
        let j = this.i + 1;
        while (j < this.s.length && this.s[j] !== "/") j += this.s[j] === "\\" ? 2 : 1;
        if (j >= this.s.length) fail("a /pattern/ is not closed");
        this.i = j + 1;
      } else this.i++;
    }
    return this.s.slice(start, this.i);
  }

  term(): FilterRule {
    const t = this.raw();
    if (!t) return fail(`unexpected "${this.peek() ?? ""}"`);
    const id = this.newId();
    const rule = (field: string, op: FilterOp, values: string[]): FilterRule => {
      for (const v of values) if (v.length > VIEW_LIMITS.pattern) fail(`a value is at most ${VIEW_LIMITS.pattern} characters`);
      return { id, field, op, values };
    };
    if (t[0] === "/") {
      if (t.length < 3 || !t.endsWith("/")) fail("a /pattern/ takes no flags; it is always case-insensitive");
      const pat = t.slice(1, -1);
      try { new RegExp(pat, "i"); } catch { fail(`"${pat}" is not a valid pattern`); }
      return rule("text", "matches", [pat]);
    }
    if (t[0] === '"' || t[0] === "'") return rule("text", "contains", [unquote(t)]);
    if (/^#\d+$/.test(t)) return rule("number", "is", [t.slice(1)]);
    if (CARD_KEY.test(t)) return rule("card", "is", [t]);
    const k = /^([A-Za-z][A-Za-z-]*):(.*)$/.exec(t);
    if (!k) return rule("text", "contains", [t]);
    const key = k[1]!.toLowerCase();
    const rest = k[2]!;
    if (!rest) return fail(`"${key}:" needs a value`);
    if (key === "has") {
      const f = rest.toLowerCase();
      if (!FIELDS.has(f)) fail(`has: does not know "${rest}"`);
      return rule(f, "set", []);
    }
    if (key === "ci") {
      const v = CI[rest.toLowerCase()];
      if (!v) return fail("ci: is failing, passing or running");
      return rule("checks", "is", [v]);
    }
    if (key === "is" && rest.toLowerCase() === "conflict") return rule("conflict", "is", ["yes"]);
    if (!FIELDS.has(key)) return fail(`unknown filter "${key}:" (quote the word to search for it)`);
    const cmp = /^([<>])(.+)$/.exec(rest);
    if (cmp) {
      const n = key === "updated" ? /^(\d+)d$/.exec(cmp[2]!)?.[1] : /^\d+$/.test(cmp[2]!) ? cmp[2] : undefined;
      if (n === undefined) return fail(key === "updated" ? "updated: takes days, like updated:>14d" : `${key}: compares whole numbers`);
      return rule(key, cmp[1] === "<" ? "lt" : "gt", [n]);
    }
    return rule(key, "is", splitValues(rest));
  }
}

function unquote(v: string): string {
  return (v[0] === '"' || v[0] === "'") && v.endsWith(v[0]) && v.length > 1 ? v.slice(1, -1) : v;
}

/** a,b,"c d" -> [a, b, "c d"]; commas inside quotes stay. */
function splitValues(s: string): string[] {
  const out: string[] = [];
  let cur = "", q = "";
  for (const c of s) {
    if (q) { if (c === q) q = ""; else cur += c; }
    else if (c === '"' || c === "'") q = c;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.filter(Boolean);
}

/** Inside a group there are no lanes: `-` and `!` both flip the op. */
function inGroup(it: Item): FilterNode {
  if (!it.neg && !it.bang) return it.node;
  if (isGroup(it.node)) return fail("a group inside a group cannot be negated");
  const op = FLIP[it.node.op];
  if (!op || it.node.field === "text") return fail("inside ( ) only facets can be negated, not words");
  return { ...it.node, op };
}

export function parseRuleText(text: string, ctx: ParseCtx = {}): ParseResult {
  const rd = new Reader(text, ctx.newId ?? defaultId);
  try {
    const alts = rd.alternatives(0);
    if (rd.peek() === ")") fail("a ) has no opening (");
    if (alts.length > 1) fail("wrap alternatives in ( ), like (a | b)");
    const add = alts[0]!.map(({ neg, bang, node }): { lane: Lane; node: FilterNode } => {
      let n = node;
      if (bang) {
        const op = !isGroup(n) && n.field !== "text" ? FLIP[n.op] : undefined;
        if (!op) return fail("! works on facets, like !author:ana");
        n = { ...(n as FilterRule), op };
      }
      return { lane: neg ? "hide" : "show", node: n };
    });
    // Same bar the server holds, so text that parses is text that can be saved.
    const check = validateLaneFilter({
      show: { id: "show", kind: "group", join: "and", children: add.filter((a) => a.lane === "show").map((a) => a.node) },
      hide: { id: "hide", kind: "group", join: "or", children: add.filter((a) => a.lane === "hide").map((a) => a.node) },
    });
    if (typeof check === "string") return { error: check };
    return { add };
  } catch (e) {
    if (e instanceof Fail) return { error: e.message };
    throw e;
  }
}

/** Bare when it reads back as itself; a word also needs to look like no other token. */
function quote(v: string, word = false): string {
  const bare = /^[^\s"'(),|\-!<>][^\s"'(),|]*$/.test(v) && (!word || !/^[#/]|:/.test(v) && !CARD_KEY.test(v));
  return bare ? v : v.includes('"') ? `'${v}'` : `"${v}"`;
}

/** The token for a rule in its natural op (is/set/contains/matches/lt/gt). */
function token(r: FilterRule): string {
  const vs = r.values;
  if (r.op === "set") return `has:${r.field}`;
  if (r.field === "text") return r.op === "matches" ? `/${vs[0]}/` : quote(vs[0] ?? "", true);
  if (r.field === "number" && vs.length === 1 && /^\d+$/.test(vs[0]!)) return `#${vs[0]}`;
  if (r.field === "card" && vs.length === 1 && CARD_KEY.test(vs[0]!)) return vs[0]!;
  if (r.field === "conflict") return "is:conflict";
  if (r.field === "checks" && vs.length === 1 && CI_BACK[vs[0]!]) return `ci:${CI_BACK[vs[0]!]}`;
  if (r.op === "lt" || r.op === "gt") return `${r.field}:${r.op === "lt" ? "<" : ">"}${vs[0]}${r.field === "updated" ? "d" : ""}`;
  return `${r.field}:${vs.map((v) => quote(v)).join(",")}`;
}

function render(n: FilterNode, lane: Lane | null): string {
  if (isGroup(n)) {
    const sep = n.join === "or" ? " | " : " ";
    return `${lane === "hide" ? "-" : ""}(${n.children.map((c) => render(c, null)).join(sep)})`;
  }
  const flipped = n.op === "not" || n.op === "unset";
  const t = token(flipped ? { ...n, op: FLIP[n.op]! } : n);
  if (lane === null) return flipped ? `-${t}` : t;
  return (lane === "hide" ? "-" : "") + (flipped ? "!" : "") + t;
}

function laneText(g: FilterGroup, lane: Lane): string[] {
  // show "or" / hide "and" decide as one unit, so they read as one group.
  const unit = (lane === "show" ? g.join === "or" : g.join === "and") && g.children.length > 1;
  if (unit) return [render(g, lane)];
  return g.children.map((c) => render(c, lane));
}

export function lanesToText(f: LaneFilter): string {
  return [...laneText(f.show, "show"), ...laneText(f.hide, "hide")].join(" ");
}

/** Card ids on these rows that `partial` could be the start of (or sit inside), for suggestions. */
export function suggestCards(partial: string, rows: PrSummary[], max = 8): string[] {
  const q = partial.trim().toLowerCase();
  if (!q) return [];
  const seen = new Set<string>();
  for (const p of rows) {
    const id = p.card && (p.card.customId ?? p.card.id);
    if (id && id.toLowerCase().includes(q)) seen.add(id);
    if (seen.size >= max) break;
  }
  return [...seen];
}
