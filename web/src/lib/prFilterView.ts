// What the filter deck says and how it is drawn, as functions that can be tested.
// The components only place what these return.
import { emptyLanes, isGroup, VIEW_LIMITS, type FilterGroup, type FilterNode, type FilterOp, type FilterRule, type LaneFilter } from "../../../shared/prFilter.ts";
import { FACETS } from "./prFilter.ts";
import type { FieldSpec } from "../components/tasks/filters.ts";
import { evalLanes, type LaneResult } from "./prFilterEval.ts";
import type { ReadField } from "../components/tasks/filters.ts";
import { lanesToText } from "./prFilterSyntax.ts";

export type LaneName = "show" | "hide";

/** Past this many rules, or with any nested group, the deck reads as a sentence. */
export const CHIP_LIMIT = 5;

/** Hidden rows get the colour of the rule that hid them, in reading order. House tokens only. */
export const CULPRIT_COLOURS = ["var(--error)", "var(--warning)", "var(--merged)", "var(--info)", "var(--success)", "var(--primary)"] as const;

const EXTRA_LABEL: Record<string, string> = {
  text: "Title or branch", number: "PR number", card: "Card", conflict: "Conflicts", updated: "Updated",
};
/** Field keys the rule editor offers on top of the board's facets, in the order the menu lists them. */
export const EXTRA_FIELDS = ["text", "card", "number", "conflict", "updated"] as const;

export function fieldLabel(key: string): string {
  return EXTRA_LABEL[key] ?? FACETS.find((f) => f.queryKey === key)?.label ?? key;
}

/** The operators a field offers, in menu order. */
export function opsFor(field: string): FilterOp[] {
  if (field === "text") return ["contains", "is", "matches"];
  if (field === "number") return ["is", "not"];
  if (field === "updated") return ["gt", "lt"];
  if (field === "conflict") return ["is", "not"];
  if (field === "card") return ["is", "not", "set", "unset"];
  return ["is", "not", "set", "unset"];
}

export function opWord(op: FilterOp, field: string): string {
  switch (op) {
    case "contains": return "contains";
    case "matches": return "matches pattern";
    case "is": return field === "text" ? "is exactly" : field === "conflict" ? "has" : "is";
    case "not": return field === "conflict" ? "has" : "is not";
    case "set": return "is set";
    case "unset": return "is not set";
    case "gt": return "more than";
    case "lt": return "less than";
  }
}

export const takesValue = (op: FilterOp) => op !== "set" && op !== "unset";

/** The value as a person says it ("5 days", "conflicts"), and whether it is code-like. */
export function valueText(r: FilterRule): { text: string; mono: boolean } {
  const vs = r.values;
  if (r.field === "conflict") return { text: r.op === "not" ? "none" : "conflicts", mono: false };
  if (r.field === "updated") return { text: `${vs[0] ?? "…"} days ago`, mono: false };
  if (r.field === "number") return { text: vs.map((v) => `#${v}`).join(", "), mono: true };
  const text = vs.join(", ");
  return { text: text || "…", mono: r.field === "text" || r.field === "card" };
}

/** "title has BETA", "Checks is passing": the chip's words. */
export function chipWords(r: FilterRule, labelOf?: (field: string, value: string) => string): { lead: string; value: string; mono: boolean } {
  const v = labelOf && r.field !== "card" && r.field !== "number" && r.field !== "text" ? { text: r.values.map((x) => labelOf(r.field, x)).join(", ") || "…", mono: false } : valueText(r);
  const label = fieldLabel(r.field);
  if (r.field === "text") {
    const lead = r.op === "matches" ? "title matches" : r.op === "is" ? "title is" : "title has";
    return { lead, value: v.text, mono: true };
  }
  if (r.field === "conflict") return { lead: "", value: r.op === "not" || r.op === "unset" ? "No conflicts" : "Has conflicts", mono: false };
  if (r.field === "updated") return { lead: "updated", value: `${r.op === "lt" ? "<" : ">"} ${v.text}`, mono: false };
  if (r.op === "set" || r.op === "unset") return { lead: label, value: r.op === "set" ? "is set" : "is not set", mono: false };
  const neg = r.op === "not";
  if (r.field === "card" || r.field === "number") return { lead: neg ? "not" : "", value: v.text, mono: v.mono };
  /* The field `is` is itself labelled "Draft" and its value reads "Draft" too, so a lead made one word twice ("Hide Draft Draft"). The value carries the whole rule. */
  if (r.field === "is") return { lead: neg ? "not" : "", value: v.text, mono: false };
  return { lead: neg ? `${label} not` : label, value: v.text, mono: false };
}

/**
 * One rule chip as the mockup draws it: a small-caps lane word ("Hide" or
 * "Show only"), then the rule. A title or branch rule reads as a quoted phrase
 * (the default "title has" is the lane word's job, not the chip's); every other
 * rule keeps its field's lead ("author not", "updated").
 */
export function ruleChipView(r: FilterRule, lane: LaneName, labelOf?: (field: string, value: string) => string): { label: string; lead: string; value: string; quoted: boolean; mono: boolean } {
  const w = chipWords(r, labelOf);
  const quoted = r.field === "text" && r.op === "contains";
  return { label: lane === "hide" ? "Hide" : "Show only", lead: quoted ? "" : w.lead, value: w.value, quoted, mono: w.mono };
}

/** "Hide · is:draft": a rule named with its lane, the way the wall sentence lists the rules that leave nothing. */
export const ruleWithLane = (lane: LaneName, n: FilterNode): string => `${lane === "hide" ? "Hide" : "Show only"} · ${nodeName(n)}`;

/**
 * What the board says when the rules hide every card: the headline and the
 * sentence, whose bold parts are the rules named by lane. More than three rules
 * are counted, not listed.
 */
export function wallCopy(f: LaneFilter, total: number): { title: string; parts: { t: string; b?: boolean }[] } {
  const named = [
    ...f.show.children.map((c) => ruleWithLane("show", c)),
    ...f.hide.children.map((c) => ruleWithLane("hide", c)),
  ];
  const title = `Your rules hide ${total === 1 ? "the only pull request" : `all ${total} pull requests`}`;
  if (named.length === 0) return { title, parts: [{ t: "The board is not empty." }] };
  if (named.length > 3) return { title, parts: [{ t: "The board is not empty: " }, { t: `${named.length} rules`, b: true }, { t: " together leave nothing." }] };
  const parts: { t: string; b?: boolean }[] = [{ t: "The board is not empty: " }];
  named.forEach((n, i) => {
    if (i > 0) parts.push({ t: i === named.length - 1 ? " and " : ", " });
    parts.push({ t: n, b: true });
  });
  parts.push({ t: named.length === 1 ? " leaves nothing." : " together leave nothing." });
  return { title, parts };
}

export function ruleCount(n: FilterNode): number {
  return isGroup(n) ? n.children.reduce((s, c) => s + ruleCount(c), 0) : 1;
}
/** Groups below the lane (the lane itself is 0). */
export function depthOf(n: FilterNode): number {
  return isGroup(n) ? 1 + n.children.reduce((m, c) => Math.max(m, isGroup(c) ? depthOf(c) : 0), 0) : 0;
}
export const laneDepth = (lane: FilterGroup): number => lane.children.reduce((m, c) => Math.max(m, isGroup(c) ? depthOf(c) : 0), 0);

export function totalRules(f: LaneFilter): number {
  return ruleCount(f.show) + ruleCount(f.hide);
}
export function isEmptyFilter(f: LaneFilter): boolean {
  return totalRules(f) === 0;
}
/** A group nested inside a lane (a lane that is itself joined "or" is not one). */
export function hasNestedGroup(f: LaneFilter): boolean {
  return [f.show, f.hide].some((l) => l.children.some(isGroup));
}

export type DeckMode = "quiet" | "chips" | "sentence";
export function deckMode(f: LaneFilter): DeckMode {
  if (isEmptyFilter(f)) return "quiet";
  return totalRules(f) > CHIP_LIMIT || hasNestedGroup(f) ? "sentence" : "chips";
}

/** The deck is one row now, so it rests open (the mockup's "Your rules"); a fold the person chose is kept per viewer. */
export const DECK_OPEN_KEY = "agx.pr.deckOpen";
export function readDeckOpen(): boolean {
  try { return localStorage.getItem(DECK_OPEN_KEY) !== "0"; } catch { return true; }
}
export function writeDeckOpen(open: boolean): void {
  try { localStorage.setItem(DECK_OPEN_KEY, open ? "1" : "0"); } catch { /* private window: the choice lasts until reload */ }
}

export const sameFilter = (a: LaneFilter, b: LaneFilter): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The culprit colour of each top-level child, show lane first then hide: the
 * order evalLanes names culprits in. A lane credited as a whole takes its
 * group id.
 */
export function culpritColours(f: LaneFilter): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  const next = () => CULPRIT_COLOURS[i++ % CULPRIT_COLOURS.length]!;
  for (const lane of [f.show, f.hide]) {
    for (const c of lane.children) out.set(c.id, next());
    out.set(lane.id, next());
  }
  return out;
}

/** The lane an id belongs to (a top-level child, a nested node, or the lane itself). */
export function laneOfId(f: LaneFilter, id: string): LaneName | null {
  const has = (n: FilterNode): boolean => n.id === id || (isGroup(n) && n.children.some(has));
  return has(f.show) ? "show" : has(f.hide) ? "hide" : null;
}

export function findNode(f: LaneFilter, id: string): FilterNode | null {
  const go = (n: FilterNode): FilterNode | null => {
    if (n.id === id) return n;
    if (isGroup(n)) for (const c of n.children) { const r = go(c); if (r) return r; }
    return null;
  };
  return go(f.show) ?? go(f.hide);
}

/** The top-level child of its lane that holds `id`: where evalLanes credits the count. */
export function topChildId(f: LaneFilter, id: string): string {
  for (const lane of [f.show, f.hide]) {
    for (const c of lane.children) if (findIn(c, id)) return c.id;
  }
  return id;
}
const findIn = (n: FilterNode, id: string): boolean => n.id === id || (isGroup(n) && n.children.some((c) => findIn(c, id)));

/** What a rule or group says, short, for slips ("hidden by title has BETA"). */
export function nodeName(n: FilterNode): string {
  if (isGroup(n)) return n.children.length ? `any of ${n.children.length}` : "an empty group";
  const w = chipWords(n);
  return [w.lead, w.value].filter(Boolean).join(" ");
}

/** The rule that hid the most rows, when nothing is left. */
export function wallRule(res: Pick<LaneResult<unknown>, "hiddenBy">, total: number, keptCount: number): { id: string; count: number } | null {
  if (total === 0 || keptCount > 0) return null;
  let best: { id: string; count: number } | null = null;
  for (const [id, count] of res.hiddenBy) if (!best || count > best.count) best = { id, count };
  return best;
}

/** True when a rule can still take a rule of its own: nesting is bounded. */
export const canNest = (depth: number) => depth < VIEW_LIMITS.depth;

/** The fields the rule editor offers: the ones with no pill, then the board's own facets. */
export function editorFields(fields: FieldSpec[], current?: string): FieldSpec[] {
  const extras: FieldSpec[] = EXTRA_FIELDS.map((k) => ({ key: k, label: fieldLabel(k), options: [] }));
  const out = [...extras, ...fields.filter((f) => !(EXTRA_FIELDS as readonly string[]).includes(f.key))];
  if (current && !out.some((f) => f.key === current)) out.push({ key: current, label: fieldLabel(current), options: [] });
  return out;
}

/** A rule with nothing in it yet, in the operator its field reaches for first. */
export function blankRule(field: string, id: string): FilterRule {
  const op = opsFor(field)[0]!;
  return { id, field, op, values: field === "conflict" ? ["yes"] : [] };
}

/** What adding this rule to this lane does, in a few words ("Hide card ORBIT-1009"). */
export function describeAdd(lane: LaneName, node: FilterNode): string {
  const verb = lane === "hide" ? "Hide" : "Show only";
  if (isGroup(node)) return `${verb} any of ${node.children.length}`;
  const v = node.values.join(", ");
  const neg = node.op === "not" || node.op === "unset";
  switch (node.field) {
    case "card": return `${verb} ${node.op === "set" ? "PRs with a card" : node.op === "unset" ? "PRs with no card" : `card ${v}`}`;
    case "number": return `${verb} PR ${node.values.map((x) => `#${x}`).join(", ")}`;
    case "text": return `${verb} ${node.op === "matches" ? `pattern /${v}/` : `words ${v}`}`;
    case "conflict": return `${verb} PRs ${neg ? "without" : "with"} conflicts`;
    case "updated": return `${verb} PRs untouched ${node.op === "gt" ? "for over" : "for under"} ${v} days`;
    default: return `${verb} ${nodeName(node)}`;
  }
}

/** Who to blame in words: the rule, or a lane that was credited as a whole. */
export function culpritName(f: LaneFilter, id: string): string {
  const n = findNode(f, id);
  if (!n) return "a rule";
  if (id === f.show.id) return "your Show only rules";
  if (id === f.hide.id) return "your Hide rules";
  return nodeName(n);
}

/** The live filter differs from what the active view saved. Compared as text: ids and order of equal rules do not count. */
export function viewDirty(live: LaneFilter, saved: LaneFilter | null): boolean {
  return lanesToText(live) !== lanesToText(saved ?? emptyLanes());
}

/**
 * evalLanes, minus one exemption the board has always had: a row with something
 * unread on it is never dropped by a rule the person built. The row stays in
 * `kept`, its culprit entry is removed, and the counts still add up.
 */
export function evalExempt<T>(rows: T[], filter: LaneFilter, read: ReadField<T>, exempt: (row: T) => boolean): LaneResult<T> {
  const r = evalLanes(rows, filter, read);
  if (!r.culprit.size) return r;
  const spared = rows.filter((row) => r.culprit.has(row) && exempt(row));
  if (!spared.length) return r;
  const culprit = new Map(r.culprit);
  const hiddenBy = new Map(r.hiddenBy);
  for (const row of spared) {
    const id = culprit.get(row)!;
    culprit.delete(row);
    hiddenBy.set(id, (hiddenBy.get(id) ?? 1) - 1);
  }
  return { kept: rows.filter((row) => !culprit.has(row)), culprit, hiddenBy };
}

/** For the board's lanes: each hidden PR's number to the rule that hid it, in words and colour. */
export function whyMap(filter: LaneFilter, culprit: Map<{ number: number }, string>): Map<number, { id: string; name: string; colour: string }> {
  const colours = culpritColours(filter);
  const out = new Map<number, { id: string; name: string; colour: string }>();
  for (const [row, id] of culprit) out.set(row.number, { id, name: culpritName(filter, id), colour: colours.get(id) ?? "var(--text3)" });
  return out;
}

/**
 * A lane's cards with its hidden rows slipped in at their own place: each goes
 * before the first card that sits later on the board than it (`rank` is the
 * board's order). A card the rank does not know sits last.
 */
export function slipIn<T extends { number: number }>(cards: readonly T[], hidden: readonly T[], rank: ReadonlyMap<number, number>): T[] {
  const at = (p: T) => rank.get(p.number) ?? Infinity;
  const out = [...cards];
  for (const h of [...hidden].sort((a, b) => at(a) - at(b))) {
    const i = out.findIndex((c) => at(c) > at(h));
    out.splice(i < 0 ? out.length : i, 0, h);
  }
  return out;
}

/**
 * What the tree editor says about rules that were just typed into the deck: each
 * new rule or group id, with the text it came from ("-BETA"), so its row can
 * carry a ring and "added from typing -BETA" for a moment.
 */
export function typedFlash(add: { lane: LaneName; node: FilterNode }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of add) {
    const only = a.lane === "show" ? { ...emptyLanes(), show: { ...emptyLanes().show, children: [a.node] } } : { ...emptyLanes(), hide: { ...emptyLanes().hide, children: [a.node] } };
    out.set(a.node.id, lanesToText(only));
  }
  return out;
}

/** How long the ring stays. Long enough to find the row, short enough not to read as a state. */
export const FLASH_MS = 3000;

/** Under this width the deck folds to its strip and the rules open as a sheet. */
export const NARROW_DECK_PX = 520;
export const deckNarrow = (width: number): boolean => width < NARROW_DECK_PX;

/*
 * Which view Alt+1..9 picks, or null. The board's rules changed with nobody
 * touching it: `altKey` on a keydown is what the browser believes, and after
 * Alt+Tab away the keyup never arrives, so a plain digit typed later still
 * reads as Alt+digit. Alt therefore counts only while a real Alt keydown has
 * been seen since the window last lost focus, and never from a box being typed
 * in (an input, or a terminal's hidden textarea).
 */
export function viewHotkey(
  e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string; target: EventTarget | null },
  altHeld: boolean,
): number | null {
  if (!altHeld || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !/^Digit[1-9]$/.test(e.code)) return null;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? ""))) return null;
  return Number(e.code.slice(5)) - 1;
}
