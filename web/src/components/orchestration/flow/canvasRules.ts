/*
 * What the canvas says about rules, as plain data: for each block (a policy
 * field, so "orchestrator" or a worker role) the engine in force, the usual one,
 * and why. Pure, so every state of the canvas (a rule in force, a preset being
 * previewed, a rule being edited, a machine check) is tested without a renderer.
 *
 * The pick of the rule that decides a field is `resolve`'s own: the first rule in
 * the list that is on and names the field. The list order is the priority; the
 * panel shows it and moves it (`withRuleMoved`).
 *
 * Its ceiling, stated: a block shows the FIRST step of the chain in force; the
 * steps behind it are the panel's.
 */
import { ROLE_IDS, type Chain, type EngineChoice, type Policy, type PolicyRule } from "../../../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../../../shared/types.ts";
import { choiceWords, engineTileState, type Field } from "../orchestrationCopy.ts";

export type MarkKind = "rule" | "preview" | "hit" | "inrule" | "faded";

export interface BlockMark {
  kind?: MarkKind;
  /** The pointer is over this block's settings in the side panel: the block glows so the person sees which one they are editing. */
  focus?: boolean;
  /** Every step the block runs through, drawn one per line on the block. */
  chain?: Chain;
  /** The pill on the block's corner. */
  tag?: string;
  /** The engine in force (or the one the rule sets). */
  now?: string;
  /** The usual engine, struck through. */
  was?: string;
  /** "Because: <rule name>". */
  because?: string;
  /** A second line of quiet text under the engine. */
  hint?: string;
  /** An engine that is not installed or not signed in. */
  warn?: string;
}
export type Marks = Partial<Record<Field, BlockMark>>;

export const FIELDS: readonly Field[] = ["orchestrator", ...ROLE_IDS];

export const chainOfField = (r: PolicyRule, f: Field): Chain | undefined => (f === "orchestrator" ? r.orchestrator : r.workers?.[f]);
export const baseChainOf = (p: Policy, f: Field): Chain => (f === "orchestrator" ? p.base.orchestrator.value : p.base.workers[f].value);

/** The fields a rule moves. */
export const ruleTouches = (r: PolicyRule): Field[] => FIELDS.filter((f) => !!chainOfField(r, f));

/** The rule that decides a field right now: the first one on that names it. */
export const liveRuleFor = (p: Policy, on: (id: string) => boolean, f: Field): PolicyRule | undefined =>
  p.rules.find((r) => r.enabled && on(r.id) && !!chainOfField(r, f));

const first = (c: Chain | undefined): EngineChoice | null => c?.[0] ?? null;
const word = (c: EngineChoice | null): string => (c ? choiceWords(c) : "its usual engine");

/** The choice a field starts with under a policy, given which rules hold. */
export function effectiveChoice(p: Policy, on: (id: string) => boolean, f: Field): EngineChoice | null {
  const r = liveRuleFor(p, on, f);
  return first(r ? chainOfField(r, f) : baseChainOf(p, f));
}

/** A rule that is acting: every field it decides right now, with the usual engine struck through. */
export function marksInForce(p: Policy, on: (id: string) => boolean): Marks {
  const out: Marks = {};
  for (const f of FIELDS) {
    const r = liveRuleFor(p, on, f);
    if (!r) continue;
    const now = word(first(chainOfField(r, f)));
    const was = word(first(baseChainOf(p, f)));
    out[f] = { kind: "rule", tag: "rule on", chain: chainOfField(r, f), now, ...(now !== was ? { was: `usually ${was}` } : {}), because: `Because: ${r.name}` };
  }
  return out;
}

/** Old → new for a policy that is not stored: the rules it adds are taken as holding, to show what they would do. */
export function marksPreview(p: Policy, next: Policy, on: (id: string) => boolean): Marks {
  const known = new Set(p.rules.map((r) => JSON.stringify(r)));
  const added = new Set(next.rules.filter((r) => !known.has(JSON.stringify(r))).map((r) => r.id));
  const out: Marks = {};
  for (const f of FIELDS) {
    const was = word(effectiveChoice(p, on, f));
    const now = word(effectiveChoice(next, (id) => added.has(id) || on(id), f));
    if (was !== now) out[f] = { kind: "preview", tag: "preview", now, was };
  }
  return out;
}

/** Hovering a rule in the list: the blocks it touches light up. */
export function marksHit(p: Policy, r: PolicyRule): Marks {
  const out: Marks = {};
  for (const f of ruleTouches(r)) {
    const now = word(first(chainOfField(r, f)));
    const was = word(first(baseChainOf(p, f)));
    out[f] = { kind: "hit", tag: r.name, now, ...(now !== was ? { was } : {}) };
  }
  return out;
}

/** While a rule is edited: the blocks in it are lit and say what the rule sets; the others fade. */
export function marksEditing(p: Policy, draft: Pick<PolicyRule, "orchestrator" | "workers">, off: ReadonlySet<Field>): Marks {
  const out: Marks = {};
  for (const f of FIELDS) {
    const c = chainOfField(draft as PolicyRule, f);
    if (!c) { out[f] = { kind: "faded", hint: off.has(f) ? "Role off in this rule · keeps its usual choice" : "not in this rule · click to add" }; continue; }
    out[f] = {
      kind: "inrule", tag: "in this rule", chain: c, now: c.map(choiceWords).slice(0, 2).join(" → "), was: `base: ${word(first(baseChainOf(p, f)))}`,
      hint: `${c.length} ${c.length === 1 ? "step" : "steps"} · edit in the panel`,
    };
  }
  return out;
}

/** "Check my setup" / "Test it now": the blocks whose engine in force is not installed or not signed in, or the one that would change. */
export function marksReadiness(p: Policy, on: (id: string) => boolean, readiness: readonly EngineReadiness[] | null): Marks {
  const out: Marks = {};
  if (!readiness) return out;
  for (const f of FIELDS) {
    const c = effectiveChoice(p, on, f);
    if (!c) continue;
    const s = engineTileState(c.engine, f === "orchestrator" ? "orchestrator" : "worker", readiness, false, c.model);
    if (s.tone === "err" || s.tone === "warn") out[f] = { warn: `${s.word}: ${s.reason}` };
  }
  return out;
}

/** Layers of marks, the later one over the earlier; the warning of any layer stays. */
export function mergeMarks(...layers: Marks[]): Marks {
  const out: Marks = {};
  for (const l of layers) for (const f of FIELDS) { const m = l[f]; if (m) out[f] = { ...out[f], ...m }; }
  return out;
}

/** The count the Conditions chip shows, and whether one of them is acting on a block. */
export function conditionCounts(p: Policy | null, on: (id: string) => boolean): { on: number; acting: boolean } {
  if (!p) return { on: 0, acting: false };
  const live = p.rules.filter((r) => r.enabled && on(r.id));
  return { on: live.length, acting: FIELDS.some((f) => !!liveRuleFor(p, on, f)) };
}

/** Moves a rule one place in the list: the list order is the priority, the first rule that holds wins. */
export function withRuleMoved(p: Policy, id: string, by: -1 | 1): Policy {
  const i = p.rules.findIndex((r) => r.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= p.rules.length) return p;
  const rules = [...p.rules];
  [rules[i], rules[j]] = [rules[j]!, rules[i]!];
  return { ...p, rules };
}

/** Rules that set the same field, in priority order: the first is the one that wins when both hold. */
export function sharedFields(p: Policy, id: string): { field: Field; with: string[]; rank: number }[] {
  const mine = p.rules.find((r) => r.id === id);
  if (!mine) return [];
  const out: { field: Field; with: string[]; rank: number }[] = [];
  for (const f of ruleTouches(mine)) {
    const all = p.rules.filter((r) => !!chainOfField(r, f));
    if (all.length > 1) out.push({ field: f, with: all.filter((r) => r.id !== id).map((r) => r.name), rank: all.findIndex((r) => r.id === id) + 1 });
  }
  return out;
}
