/*
 * How this workspace uses ClickUp, kept beside the boards it applies to.
 *
 * Two kinds of setting live here and the difference matters: how ClickUp works
 * (nothing, that is code) and how one team happens to use it (a QA column with
 * a particular name, a field for the PR link, a sprint naming habit). Only the
 * second is a preference. The defaults reproduce what the app did before this
 * file existed, except the two flows that were one team's habit, which start off.
 *
 * Plain JSON in the config directory for the reason clickup-views.json is: a
 * handful of short strings a person may want to read or edit. No secret here.
 *
 * Patterns are stored as sources and compiled by whoever uses them, so the file
 * stays editable by hand. Saving refuses one that does not compile; a file
 * edited by hand into something invalid falls back to the default for that key
 * rather than breaking every surface that reads it.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { CLICKUP_BELL_KINDS, DEFAULT_SPRINT_LIST_PATTERN, DEFAULT_READ_ONLY_FIELD_PATTERN } from "../../shared/providers.ts";
import { DEFAULT_CARD_SKILL_PATTERN } from "../../shared/cardSkills.ts";
import type { ClickUpPrefs, ClickUpBellKind, HandoffUnassign, StepAssign, StepBlock } from "../../shared/providers.ts";
import { MAX_BLOCKS, blocksFromLegacy, blocksProblem, legacyFromBlocks, type StepTrigger } from "../../shared/stepBlocks.ts";

const FILE = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "clickup-prefs.json",
);

/** Test seam, so a suite never reads or writes the developer's own settings. */
let override: string | null = null;
export function __setPrefsPath(p: string | null): void { override = p; cache = undefined; }
const path = (): string => override ?? FILE;

/** What each pattern was before it was a setting: clickup.ts, cardSkills.ts. */
export { DEFAULT_CARD_SKILL_PATTERN, DEFAULT_SPRINT_LIST_PATTERN, DEFAULT_READ_ONLY_FIELD_PATTERN };

/** A name is a few words; a list is a handful. A body past these is not a form. */
const MAX_TEXT = 200;
const MAX_ITEMS = 20;

/**
 * A pattern that can take exponential time on a name it does not match. Measured
 * with Bun: `^(a|a)+$` against "a" x 24 + "b" takes 143 ms and doubles with each
 * further character; the names it is tested against are typed by anyone in the
 * workspace, and the test runs on the server's only thread.
 *
 * A heuristic, not a proof. It refuses what that blow-up needs: a group that
 * holds an alternation or a quantifier and is itself repeated without a bound,
 * and a backreference. Nested bounded repeats (`(a{1,3}){1,3}`) and overlapping
 * adjacent quantifiers (`a*a*a*b`) are polynomial and are not caught here; the
 * length cap in `matchPref` is what bounds those.
 */
export function patternProblem(src: string): string | null {
  if (/\\[1-9]|\\k</.test(src)) return "uses a backreference";
  for (const m of src.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*(?:[+*]|\{\d+,\d*\})/g)) {
    if (/[+*|]|\{\d+,/.test(m[1]!.replace(/\\./g, ""))) return "repeats a group that already repeats or branches";
  }
  return null;
}

/** The longest name a saved pattern is tested against. Names are a few words. */
const MAX_TESTED = 200;
/** Test a saved pattern against a name typed by somebody else. */
export function matchPref(src: string, fallback: string, name: string): boolean {
  return prefPattern(src, fallback).test(name.slice(0, MAX_TESTED));
}

/** A saved pattern, compiled once per source. Falls back to `fallback` when it
 *  does not compile: a hand-edited file must not break the board it applies to. */
const compiled = new Map<string, RegExp>();
export function prefPattern(src: string, fallback: string): RegExp {
  const key = `${src}\u0000${fallback}`;
  let re = compiled.get(key);
  if (!re) {
    try {
      if (src && patternProblem(src)) throw new Error("unsafe");
      re = new RegExp(src || fallback, "i");
    } catch { re = new RegExp(fallback, "i"); }
    compiled.set(key, re);
  }
  return re;
}

export function defaultPrefs(): ClickUpPrefs {
  return {
    handoff: { enabled: false, blocks: [], statusNames: [], unassign: "none", assign: { who: "none" } },
    review: { enabled: false, blocks: [], statusNames: [], assignReviewer: false, assign: { who: "none" } },
    merge: { enabled: false, blocks: [], statusNames: [], assign: { who: "none" } },
    flows: { noteOnCard: false },
    prLinkField: "",
    swatchField: "",
    cardSkillPattern: DEFAULT_CARD_SKILL_PATTERN,
    assigned: { includeSubtasks: false },
    sprintListPattern: DEFAULT_SPRINT_LIST_PATTERN,
    readOnlyFieldPattern: DEFAULT_READ_ONLY_FIELD_PATTERN,
    bell: { kinds: [...CLICKUP_BELL_KINDS] },
    statusSpaces: { counted: [] },
  };
}

type StepGroup = { enabled: boolean; statusNames: string[]; unassign?: HandoffUnassign; assign: StepAssign; blocks?: StepBlock[] };
type Fail = { ok: false; error: string };
type Ok<T> = { ok: true; value: T };
type Res<T> = Ok<T> | Fail;
const bad = (error: string): Fail => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function bool(name: string, v: unknown): Res<boolean> {
  return typeof v === "boolean" ? { ok: true, value: v } : bad(`${name} must be true or false`);
}
function text(name: string, v: unknown): Res<string> {
  if (typeof v !== "string") return bad(`${name} must be text`);
  const t = v.trim();
  return t.length > MAX_TEXT ? bad(`${name} is longer than ${MAX_TEXT} characters`) : { ok: true, value: t };
}
function names(name: string, v: unknown): Res<string[]> {
  if (!Array.isArray(v)) return bad(`${name} must be a list of names`);
  if (v.length > MAX_ITEMS) return bad(`${name} has more than ${MAX_ITEMS} entries`);
  const out: string[] = [];
  for (const x of v) {
    const t = text(name, x);
    if (!t.ok) return t;
    if (t.value && !out.includes(t.value)) out.push(t.value);
  }
  return { ok: true, value: out };
}
function pattern(name: string, v: unknown, fallback: string): Res<string> {
  const t = text(name, v);
  if (!t.ok) return t;
  if (!t.value) return { ok: true, value: fallback };
  try { new RegExp(t.value, "i"); } catch (e) {
    return bad(`${name} is not a valid pattern: ${(e as Error).message}`);
  }
  const problem = patternProblem(t.value);
  if (problem) return bad(`${name} ${problem}, which can hang the app on a long name`);
  return { ok: true, value: t.value };
}

/** One step's "also assign": replaced whole, never merged field by field, so a
 *  person left over from an earlier choice cannot survive a switch to `me`. */
function assign(name: string, v: unknown): Res<StepAssign> {
  if (!isObj(v)) return bad(`${name} must be an object like {"who":"me"}`);
  for (const k of Object.keys(v)) if (k !== "who" && k !== "person") return bad(`${name}.${k} is not a setting`);
  const w = v.who;
  if (w !== "none" && w !== "me" && w !== "author" && w !== "person") return bad(`${name}.who must be none, me, author or person`);
  if (w !== "person") {
    return "person" in v && v.person != null ? bad(`${name}.person is only for who: "person"`) : { ok: true, value: { who: w } };
  }
  const p = v.person;
  if (!isObj(p)) return bad(`${name}.person must be {"id": <member id>, "name": "<name>"} when who is person`);
  for (const k of Object.keys(p)) if (k !== "id" && k !== "name") return bad(`${name}.person.${k} is not a setting`);
  if (typeof p.id !== "number" || !Number.isSafeInteger(p.id) || p.id <= 0) return bad(`${name}.person.id must be a member id`);
  const n = text(`${name}.person.name`, p.name);
  if (!n.ok) return n;
  if (!n.value) return bad(`${name}.person.name must be the member's name`);
  return { ok: true, value: { who: "person", person: { id: p.id, name: n.value } } };
}

/**
 * A step's block list: replaced whole, in the order given. Each block is checked
 * the way the screen checks it (see blocksProblem), so a list the page would not
 * offer is not saved by hand either, and an unknown key is refused like anywhere else.
 */
function blockList(name: string, v: unknown, trigger: StepTrigger): Res<StepBlock[]> {
  if (!Array.isArray(v)) return bad(`${name} must be a list of blocks`);
  if (v.length > MAX_BLOCKS) return bad(`${name} has more than ${MAX_BLOCKS} blocks`);
  const out: StepBlock[] = [];
  for (const [i, b] of v.entries()) {
    const at = `${name}[${i}]`;
    if (!isObj(b)) return bad(`${at} must be an object like {"type":"move","statusNames":["..."]}`);
    if (b.type === "move") {
      for (const k of Object.keys(b)) if (k !== "type" && k !== "statusNames" && k !== "fallback" && k !== "ask") return bad(`${at}.${k} is not a setting`);
      const r = names(`${at}.statusNames`, "statusNames" in b ? b.statusNames : []);
      if (!r.ok) return r;
      if ("fallback" in b && typeof b.fallback !== "boolean") return bad(`${at}.fallback must be true or false`);
      if ("ask" in b && b.ask !== true && b.ask !== false) return bad(`${at}.ask must be true or false`);
      out.push({ type: "move", statusNames: r.value, ...(b.fallback === true && !r.value.length ? { fallback: true } : null), ...(b.ask === true ? { ask: true as const } : null) });
    } else if (b.type === "unassign") {
      for (const k of Object.keys(b)) if (k !== "type" && k !== "who" && k !== "ask") return bad(`${at}.${k} is not a setting`);
      if (b.ask === true) return bad(`${at}.ask is for move and assign blocks; “take people off” does not ask when it runs yet`);
      if (b.who !== "none" && b.who !== "me" && b.who !== "all") return bad(`${at}.who must be none, me or all`);
      out.push({ type: "unassign", who: b.who });
    } else if (b.type === "assign") {
      const { type: _t, ask, ...rest } = b;
      if (ask !== undefined && ask !== true && ask !== false) return bad(`${at}.ask must be true or false`);
      const r = assign(at, rest);
      if (!r.ok) return r;
      if (r.value.who === "none" && ask !== true) return bad(`${at}.who must be me, author or person: remove the block to assign nobody (or set ask: true, where none is “nobody” as the starting choice)`);
      out.push({ type: "assign", ...(ask === true ? { ask: true as const } : null), ...r.value });
    } else return bad(`${at}.type must be move, unassign or assign`);
  }
  const problem = blocksProblem(trigger, out);
  return problem ? bad(`${name} ${problem}`) : { ok: true, value: out };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A block that asks when it runs has no place in the three old keys, so a save that only knows those keys
 * must not drop it: the ask on a move survives while the names stay what they were, and an asking assign
 * survives unless the save set an assignment itself.
 */
function carryAsk(prev: StepBlock[] | undefined, next: StepBlock[], assignSet: boolean, namesSet: boolean): StepBlock[] {
  if (!prev) return next;
  const out = [...next];
  const pm = prev.find((b) => b.type === "move" && b.ask);
  const mi = out.findIndex((b) => b.type === "move");
  if (pm && pm.type === "move" && mi >= 0 && !namesSet) out[mi] = { ...(out[mi] as Extract<StepBlock, { type: "move" }>), ask: true };
  const pa = prev.find((b) => b.type === "assign" && b.ask);
  if (pa && !assignSet && !out.some((b) => b.type === "assign")) out.push(pa);
  /* The order the person gave stays: kinds that were there keep their places, new ones follow. */
  const at = (b: StepBlock) => { const i = prev.findIndex((x) => x.type === b.type); return i < 0 ? prev.length + out.indexOf(b) : i; };
  return [...out].sort((x, y) => at(x) - at(y));
}

/**
 * Apply a partial update on top of `base`. Unknown keys are refused rather than
 * ignored: a typo that is silently dropped looks exactly like a setting that
 * was saved. Nested groups merge one level, so `{ handoff: { enabled: true } }`
 * leaves the other two hand-off keys as they were.
 */
export function applyPrefs(base: ClickUpPrefs, input: unknown): Res<ClickUpPrefs> {
  if (!isObj(input)) return bad("settings must be an object");
  const out: ClickUpPrefs = structuredClone(base);
  const groupOf = (k: string, allowed: string[]): Res<Record<string, unknown>> => {
    const g = input[k];
    if (!isObj(g)) return bad(`${k} must be an object`);
    for (const key of Object.keys(g)) if (!allowed.includes(key)) return bad(`${k}.${key} is not a setting`);
    return { ok: true, value: g };
  };
  /* Blocks and the three old keys are one step written two ways. Blocks given: they win, and the old keys
     are rewritten from them (a patch that sets both must agree, or it is refused rather than half kept).
     Only old keys given: the blocks are read from them, as a file from before blocks is. */
  const settle = (key: string, trigger: StepTrigger, patch: Record<string, unknown>, now: StepGroup, was: StepGroup): Res<true> => {
    if ("blocks" in patch) {
      const r = blockList(`${key}.blocks`, patch.blocks, trigger);
      if (!r.ok) return r;
      const l = legacyFromBlocks(r.value);
      for (const k of ["statusNames", "unassign", "assign"] as const) {
        if (k in patch && !same(now[k], l[k])) return bad(`${key}.${k} says something different from ${key}.blocks: set one of them`);
      }
      now.blocks = r.value;
      now.statusNames = l.statusNames; now.assign = l.assign;
      if ("unassign" in now) now.unassign = l.unassign;
    } else if (["enabled", "statusNames", "unassign", "assign"].some((k) => k in patch)) {
      const next = blocksFromLegacy(trigger, { enabled: now.enabled, statusNames: now.statusNames, unassign: now.unassign, assign: now.assign });
      now.blocks = carryAsk(was.blocks, next, "assign" in patch, "statusNames" in patch);
    } else now.blocks = was.blocks;
    return { ok: true, value: true };
  };
  const top = ["handoff", "review", "merge", "flows", "prLinkField", "swatchField", "cardSkillPattern", "assigned", "sprintListPattern", "readOnlyFieldPattern", "bell", "statusSpaces"];
  for (const k of Object.keys(input)) if (!top.includes(k)) return bad(`${k} is not a setting`);

  if ("handoff" in input) {
    const g = groupOf("handoff", ["enabled", "blocks", "statusNames", "unassign", "assign"]);
    if (!g.ok) return g;
    if ("enabled" in g.value) { const r = bool("handoff.enabled", g.value.enabled); if (!r.ok) return r; out.handoff.enabled = r.value; }
    if ("statusNames" in g.value) { const r = names("handoff.statusNames", g.value.statusNames); if (!r.ok) return r; out.handoff.statusNames = r.value; }
    if ("unassign" in g.value) {
      const u = g.value.unassign;
      if (u !== "none" && u !== "me" && u !== "all") return bad("handoff.unassign must be none, me or all");
      out.handoff.unassign = u as HandoffUnassign;
    }
    if ("assign" in g.value) { const r = assign("handoff.assign", g.value.assign); if (!r.ok) return r; out.handoff.assign = r.value; }
    const s = settle("handoff", "move", g.value, out.handoff, base.handoff); if (!s.ok) return s;
  }
  if ("review" in input) {
    const g = groupOf("review", ["enabled", "blocks", "statusNames", "assignReviewer", "assign"]);
    if (!g.ok) return g;
    if ("enabled" in g.value) { const r = bool("review.enabled", g.value.enabled); if (!r.ok) return r; out.review.enabled = r.value; }
    if ("statusNames" in g.value) { const r = names("review.statusNames", g.value.statusNames); if (!r.ok) return r; out.review.statusNames = r.value; }
    if ("assignReviewer" in g.value) { const r = bool("review.assignReviewer", g.value.assignReviewer); if (!r.ok) return r; out.review.assignReviewer = r.value; }
    if ("assign" in g.value) { const r = assign("review.assign", g.value.assign); if (!r.ok) return r; out.review.assign = r.value; }
    const s = settle("review", "menu", g.value, out.review, base.review); if (!s.ok) return s;
  }
  if ("merge" in input) {
    const g = groupOf("merge", ["enabled", "blocks", "statusNames", "assign"]);
    if (!g.ok) return g;
    if ("enabled" in g.value) { const r = bool("merge.enabled", g.value.enabled); if (!r.ok) return r; out.merge.enabled = r.value; }
    if ("statusNames" in g.value) { const r = names("merge.statusNames", g.value.statusNames); if (!r.ok) return r; out.merge.statusNames = r.value; }
    if ("assign" in g.value) { const r = assign("merge.assign", g.value.assign); if (!r.ok) return r; out.merge.assign = r.value; }
    const s = settle("merge", "merge", g.value, out.merge, base.merge); if (!s.ok) return s;
  }
  if ("flows" in input) {
    const g = groupOf("flows", ["noteOnCard"]);
    if (!g.ok) return g;
    if ("noteOnCard" in g.value) { const r = bool("flows.noteOnCard", g.value.noteOnCard); if (!r.ok) return r; out.flows.noteOnCard = r.value; }
  }
  if ("assigned" in input) {
    const g = groupOf("assigned", ["includeSubtasks"]);
    if (!g.ok) return g;
    if ("includeSubtasks" in g.value) { const r = bool("assigned.includeSubtasks", g.value.includeSubtasks); if (!r.ok) return r; out.assigned.includeSubtasks = r.value; }
  }
  if ("bell" in input) {
    const g = groupOf("bell", ["kinds"]);
    if (!g.ok) return g;
    if ("kinds" in g.value) {
      const k = g.value.kinds;
      if (!Array.isArray(k)) return bad("bell.kinds must be a list");
      for (const x of k) if (!CLICKUP_BELL_KINDS.includes(x as ClickUpBellKind)) return bad(`bell.kinds has an unknown kind: ${String(x).slice(0, 40)}`);
      out.bell.kinds = CLICKUP_BELL_KINDS.filter((x) => k.includes(x));
    }
  }
  if ("statusSpaces" in input) {
    const g = groupOf("statusSpaces", ["counted"]);
    if (!g.ok) return g;
    if ("counted" in g.value) {
      const r = names("statusSpaces.counted", g.value.counted);
      if (!r.ok) return r;
      // A space id is digits; anything else would only ever match nothing, so it is refused loudly rather than saved.
      if (r.value.some((x) => !/^[0-9]{1,20}$/.test(x))) return bad("statusSpaces.counted must be a list of space ids");
      out.statusSpaces.counted = r.value;
    }
  }
  if ("prLinkField" in input) { const r = text("prLinkField", input.prLinkField); if (!r.ok) return r; out.prLinkField = r.value; }
  if ("swatchField" in input) { const r = text("swatchField", input.swatchField); if (!r.ok) return r; out.swatchField = r.value; }
  if ("cardSkillPattern" in input) { const r = pattern("cardSkillPattern", input.cardSkillPattern, DEFAULT_CARD_SKILL_PATTERN); if (!r.ok) return r; out.cardSkillPattern = r.value; }
  if ("sprintListPattern" in input) { const r = pattern("sprintListPattern", input.sprintListPattern, DEFAULT_SPRINT_LIST_PATTERN); if (!r.ok) return r; out.sprintListPattern = r.value; }
  if ("readOnlyFieldPattern" in input) { const r = pattern("readOnlyFieldPattern", input.readOnlyFieldPattern, DEFAULT_READ_ONLY_FIELD_PATTERN); if (!r.ok) return r; out.readOnlyFieldPattern = r.value; }
  return { ok: true, value: out };
}

let cache: ClickUpPrefs | undefined;

/** What is on disk laid over the defaults. A key that no longer validates (a
 *  hand edit, an older file) keeps its default; the rest still apply. */
export function clickupPrefs(): ClickUpPrefs {
  if (cache) return cache;
  let prefs = defaultPrefs();
  try {
    const p = path();
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (isObj(raw)) {
        for (const k of Object.keys(raw)) {
          let r = applyPrefs(prefs, { [k]: raw[k] });
          /* A step whose old keys were edited by hand to disagree with its blocks: the blocks are what the page
             writes and shows, so they win, rather than the whole step falling back to its defaults. */
          if (!r.ok && isObj(raw[k]) && "blocks" in (raw[k] as object) && (k === "handoff" || k === "review" || k === "merge")) {
            const { statusNames: _s, unassign: _u, assign: _a, ...rest } = raw[k] as Record<string, unknown>;
            r = applyPrefs(prefs, { [k]: rest });
          }
          if (r.ok) prefs = r.value;
        }
        /* A file from before the review menu and the merge choice were steps: both
           were always there, so they stay for anyone the file shows using ClickUp
           (a hand-off, reviewers, a note or review names set). A file of pure
           defaults is the marker `settleFirstRun` writes for a machine with no
           token yet, and that person connects later with nothing on. Only a file
           that never heard of the key reads this way; one written since says
           `enabled` itself. Ceiling: somebody who had switched all of those off
           and kept only the review item loses it once, and can add it back. */
        if (!isObj(raw.review) || !("enabled" in raw.review)) {
          const usedIt = prefs.handoff.enabled || prefs.review.assignReviewer || prefs.flows.noteOnCard || prefs.review.statusNames.length > 0;
          if (usedIt) {
            prefs.review.enabled = true; prefs.merge.enabled = true;
            prefs.review.blocks = blocksFromLegacy("menu", prefs.review);
            prefs.merge.blocks = blocksFromLegacy("merge", prefs.merge);
          }
        }
      }
    }
  } catch { /* unreadable file: the defaults are the app as it was */ }
  cache = prefs;
  return prefs;
}

/**
 * The first start after the settings existed, decided once.
 *
 * A person who already had ClickUp connected had the review menu's move, the
 * reviewer list, the merge dialog's card choice, the Note on card and the hand-off
 * to the QA column; the defaults above switch all five off, so an update would take them away until
 * Settings was opened. So when there is no file and a token exists, the file is
 * written with those five on
 * — the hand-off clearing every assignee, as it always did — and every other
 * key at its default.
 *
 * Everyone else gets the defaults written as a marker, and that is the point of
 * writing anything at all: without it the first start with no token and the
 * first start after connecting look the same, and somebody who connected today
 * would be handed another team's habits. The file is read by nothing but this
 * app, and a fresh machine sees no difference.
 *
 * The ceiling: it runs once per start, so a file deleted by hand while a token
 * exists is seeded again on the next start.
 */
export function settleFirstRun(connected: boolean): "seeded" | "defaults" | "kept" {
  const p = path();
  if (existsSync(p)) return "kept";
  const first = defaultPrefs();
  if (connected) {
    first.handoff.enabled = true;
    first.handoff.unassign = "all";
    first.review.enabled = true;
    first.merge.enabled = true;
    first.review.assignReviewer = true;
    first.flows.noteOnCard = true;
    first.handoff.blocks = blocksFromLegacy("move", first.handoff);
    first.review.blocks = blocksFromLegacy("menu", first.review);
    first.merge.blocks = blocksFromLegacy("merge", first.merge);
  }
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(first, null, 2) + "\n");
  } catch { return "kept"; /* unwritable: the defaults stand, and the next start asks again */ }
  cache = undefined;
  return connected ? "seeded" : "defaults";
}

/** Validate, merge and write. Nothing is written when anything is refused. */
export function setClickupPrefs(input: unknown): { ok: true; prefs: ClickUpPrefs } | { ok: false; error: string } {
  const r = applyPrefs(clickupPrefs(), input);
  if (!r.ok) return r;
  const p = path();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(r.value, null, 2) + "\n");
    renameSync(tmp, p);
  } catch (e) {
    return { ok: false, error: `could not save the settings: ${(e as Error).message}` };
  }
  cache = r.value;
  return { ok: true, prefs: r.value };
}
