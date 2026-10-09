/*
 * SAVED FILTER SETS, as data. Everything a preset does that is not a pixel.
 *
 * A preset is the rule builder's own value (`FilterSet`) with a name on it, kept
 * per repository for the reason the live filter is: a rule names one tracker's
 * statuses and people, so a "Pre-QA" saved on one board would be a rule that
 * matches nothing on another. Stored as plain JSON under one key, so moving it
 * to server config later (to share it with the phone) is a storage swap and
 * nothing here changes.
 *
 * What is NOT stored: rule ids (the builder owns those and they are made fresh
 * on apply), and whether a preset is "modified". That is derived — the live
 * rules compared with the saved ones — because a flag somebody has to remember
 * to clear is a flag that goes stale.
 *
 * Ceilings, chosen: twelve per repository and twenty-four characters a name. A
 * toolbar shows four chips and the rest sit behind a menu; a thirteenth preset
 * is a list somebody should be searching rather than scanning, which is a
 * different control and is not here.
 */
import { OPS, isLive, takesValues, type FieldSpec, type FilterSet, type Op, type Rule } from "../components/tasks/filters.ts";

export const PRESETS_KEY = "agentglass.pr.filterPresets";
export const ACTIVE_KEY = "agentglass.pr.filterPresetActive";
export const MAX_PRESETS = 12;
export const MAX_NAME = 24;

export interface PresetRule { field: string; op: Op; values: string[] }
export interface Preset { id: string; name: string; join: "and" | "or"; rules: PresetRule[]; order: number }

const VALID_OPS = new Set<Op>(["is", "not", "set", "unset"]);

/* ---------------------------------------------------------------- reading */

function readRule(raw: unknown): PresetRule | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Record<string, unknown>;
  if (typeof x.field !== "string" || !x.field) return null;
  if (typeof x.op !== "string" || !VALID_OPS.has(x.op as Op)) return null;
  if (!Array.isArray(x.values) || !x.values.every((v) => typeof v === "string")) return null;
  return { field: x.field, op: x.op as Op, values: x.values as string[] };
}

/** A name as it is kept: trimmed, inner runs of space collapsed. */
export const cleanName = (raw: string): string => raw.replace(/\s+/g, " ").trim();

/**
 * One repository's presets, read back from storage, which promises nothing about
 * its shape. A malformed preset is dropped and its neighbours kept (the same
 * deal `readFilterSet` makes with a rule); a repeated id or name keeps the first;
 * past the cap the rest are dropped; one whose every rule was malformed is
 * dropped too, since it would apply as no filter at all. `order` is renumbered
 * from the array, which is the order.
 */
export function readPresetList(raw: unknown): Preset[] {
  if (!Array.isArray(raw)) return [];
  const out: Preset[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const r of raw) {
    if (out.length >= MAX_PRESETS) break;
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    if (typeof x.id !== "string" || !x.id || ids.has(x.id)) continue;
    if (typeof x.name !== "string") continue;
    const name = cleanName(x.name);
    if (!name || name.length > MAX_NAME || names.has(name.toLowerCase())) continue;
    if (x.join !== "and" && x.join !== "or") continue;
    if (!Array.isArray(x.rules)) continue;
    const rules = x.rules.map(readRule).filter((q): q is PresetRule => q !== null);
    // Every rule malformed leaves a preset that applies as "show everything".
    if (!rules.length) continue;
    ids.add(x.id);
    names.add(name.toLowerCase());
    out.push({ id: x.id, name, join: x.join, rules, order: out.length });
  }
  return out;
}

/** The whole map. Anything that is not an object of lists is the empty map; a
 *  repository whose list is not an array has none, and the others are kept. */
export function readPresetMap(raw: unknown): Record<string, Preset[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, Preset[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = readPresetList(v);
  return out;
}

/** The remembered active id per repository; anything that is not a string is dropped. */
export function readActiveMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string" && v) out[k] = v;
  return out;
}

/* -------------------------------------------------------------- the filter */

/** What a preset keeps of the live rules: the ones that are doing something. A
 *  half-written row is not a filter and is not saved as one. */
export function rulesToPreset(f: FilterSet): PresetRule[] {
  return f.rules.filter(isLive).map((r) => ({ field: r.field, op: r.op, values: takesValues(r.op) ? [...r.values] : [] }));
}

/** A preset as the builder's own value. Ids are made here, fresh: the builder
 *  keys its rows by them and a saved id would collide with a row still on screen. */
export function presetToFilterSet(p: Pick<Preset, "join" | "rules">, newId: () => string): FilterSet {
  return { join: p.join, rules: p.rules.map((r) => ({ id: newId(), field: r.field, op: r.op, values: [...r.values] })) };
}

/**
 * Two rule sets as one string, equal exactly when they filter the same.
 *
 * Rule ids and the order of values do not matter; neither does the order of the
 * rules, since a join is symmetric; neither does a half-written row; and the
 * join stops mattering with fewer than two rules, because flipping AND to OR
 * over one rule changes nothing the board can show.
 */
export function canonical(join: "and" | "or", rules: readonly { field: string; op: Op; values: readonly string[] }[]): string {
  const live = rules
    .filter((r) => isLive(r as Rule))
    .map((r) => JSON.stringify([r.field, r.op, takesValues(r.op) ? [...new Set(r.values)].sort() : []]))
    .sort();
  return JSON.stringify([live.length > 1 ? join : "and", live]);
}

/** The live rules differ from what the preset saved. Derived, never stored. */
export const isModified = (p: Preset, live: FilterSet): boolean => canonical(live.join, live.rules) !== canonical(p.join, p.rules);

/* ------------------------------------------------------------------ names */

export type NameVerdict = { ok: true; name: string } | { ok: false; reason: "empty" | "long" | "taken"; name: string };

/** Is this a name the list can take? `exceptId` is the preset being renamed, so
 *  it does not collide with itself. Case does not count: "mine" is "Mine". */
export function checkName(raw: string, list: readonly Preset[], exceptId?: string): NameVerdict {
  const name = cleanName(raw);
  if (!name) return { ok: false, reason: "empty", name };
  if (name.length > MAX_NAME) return { ok: false, reason: "long", name };
  const k = name.toLowerCase();
  if (list.some((p) => p.id !== exceptId && p.name.toLowerCase() === k)) return { ok: false, reason: "taken", name };
  return { ok: true, name };
}

/** "Name", then "Name 2", "Name 3"…, shortened so the suffix still fits. */
export function freeName(base: string, list: readonly Preset[]): string {
  const b = cleanName(base).slice(0, MAX_NAME).trim() || "Preset";
  if (checkName(b, list).ok) return b;
  for (let n = 2; n < 100; n++) {
    const suffix = ` ${n}`;
    const name = `${b.slice(0, MAX_NAME - suffix.length).trim()}${suffix}`;
    if (checkName(name, list).ok) return name;
  }
  return b;
}

/* ------------------------------------------------------------- the list's edits */

export const canAdd = (list: readonly Preset[]): boolean => list.length < MAX_PRESETS;

const renumber = (list: Preset[]): Preset[] => list.map((p, i) => (p.order === i ? p : { ...p, order: i }));

export type Edit = { ok: true; list: Preset[]; preset: Preset } | { ok: false; reason: "empty" | "long" | "taken" | "full" | "missing" };

/** Append a preset made of the live filter. Refused for a bad name, a full list,
 *  or nothing to keep (the caller disables Save then; this is the second lock). */
export function addPreset(list: Preset[], rawName: string, live: FilterSet, id: string): Edit {
  if (!canAdd(list)) return { ok: false, reason: "full" };
  const v = checkName(rawName, list);
  if (!v.ok) return { ok: false, reason: v.reason };
  const rules = rulesToPreset(live);
  if (!rules.length) return { ok: false, reason: "empty" };
  const preset: Preset = { id, name: v.name, join: live.join, rules, order: list.length };
  return { ok: true, list: [...list, preset], preset };
}

/** Overwrite a preset's rules with the live filter. Name and place stay. */
export function updatePreset(list: Preset[], id: string, live: FilterSet): Edit {
  const at = list.findIndex((p) => p.id === id);
  if (at < 0) return { ok: false, reason: "missing" };
  const rules = rulesToPreset(live);
  if (!rules.length) return { ok: false, reason: "empty" };
  const preset = { ...list[at], join: live.join, rules };
  return { ok: true, list: list.map((p, i) => (i === at ? preset : p)), preset };
}

export function renamePreset(list: Preset[], id: string, rawName: string): Edit {
  const at = list.findIndex((p) => p.id === id);
  if (at < 0) return { ok: false, reason: "missing" };
  const v = checkName(rawName, list, id);
  if (!v.ok) return { ok: false, reason: v.reason };
  const preset = { ...list[at], name: v.name };
  return { ok: true, list: list.map((p, i) => (i === at ? preset : p)), preset };
}

/** Replace a preset's rules outright (the "gone value" repairs). */
export function setPresetRules(list: Preset[], id: string, rules: PresetRule[]): Preset[] {
  return list.map((p) => (p.id === id ? { ...p, rules } : p));
}

/** What a delete took, so the undo can put it back exactly where it was. */
export interface Removed { preset: Preset; index: number }

export function deletePreset(list: Preset[], id: string): { list: Preset[]; removed: Removed } | null {
  const index = list.findIndex((p) => p.id === id);
  if (index < 0) return null;
  return { list: renumber(list.filter((p) => p.id !== id)), removed: { preset: list[index], index } };
}

/** Put a deleted preset back in the same place. If its name was taken meanwhile
 *  it comes back as "Name 2" rather than not at all; a full list refuses. */
export function restorePreset(list: Preset[], r: Removed): Preset[] | null {
  if (!canAdd(list) || list.some((p) => p.id === r.preset.id)) return null;
  const name = freeName(r.preset.name, list);
  const at = Math.min(r.index, list.length);
  return renumber([...list.slice(0, at), { ...r.preset, name }, ...list.slice(at)]);
}

/** One step left (-1) or right (+1). At an end it is the same list. */
export function movePreset(list: Preset[], id: string, dir: -1 | 1): Preset[] {
  const from = list.findIndex((p) => p.id === id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return renumber(next);
}

/* ------------------------------------------------------------ gone values */

export interface Gone { ruleIndex: number; field: string; fieldLabel: string; value: string }

/**
 * Values a preset names that the board does not offer any more.
 *
 * A rule whose FIELD is not offered is not reported: an empty board (nothing
 * loaded yet) offers no fields, and every preset would be flagged for it. A
 * value is gone only when its field is there and the value is not among the
 * field's options.
 *
 * The ceiling, said out loud: the options are what the board derives from the
 * cards and the tracker's status list it has loaded, so a person with no card
 * on screen today can read as "gone". The flag is a warning with a one-click
 * way out, not a deletion; nothing is ever removed without being asked.
 */
export function goneValues(rules: readonly PresetRule[], fields: readonly FieldSpec[]): Gone[] {
  const out: Gone[] = [];
  rules.forEach((r, ruleIndex) => {
    if (!takesValues(r.op)) return;
    const f = fields.find((x) => x.key === r.field);
    if (!f) return;
    const have = new Set(f.options.map((o) => o.value));
    for (const value of r.values) if (!have.has(value)) out.push({ ruleIndex, field: r.field, fieldLabel: f.label, value });
  });
  return out;
}

/** The rules without the missing values. A rule left with no value at all would
 *  filter nothing, which is not what "remove the missing value" means, so it goes. */
export function dropGone(rules: readonly PresetRule[], fields: readonly FieldSpec[]): PresetRule[] {
  const gone = goneValues(rules, fields);
  const bad = new Set(gone.map((g) => `${g.ruleIndex}\u0000${g.value}`));
  const out: PresetRule[] = [];
  rules.forEach((r, i) => {
    const values = r.values.filter((v) => !bad.has(`${i}\u0000${v}`));
    if (takesValues(r.op) && !values.length) return;
    out.push({ ...r, values });
  });
  return out;
}

/* ----------------------------------------------------------------- counts */

/**
 * How many cards each preset would show.
 *
 * `rowsOf` is the board's own filter (applyRulesKeepUnread over its pools) so
 * the number on a chip can never be a second opinion about what the board shows;
 * `keyOf` dedupes a pull request that is both yours and asked of you, the way
 * the board's own count does. The pools are walked once per preset.
 */
export function presetCounts<T>(
  presets: readonly Preset[], pools: readonly (readonly T[])[],
  rowsOf: (pool: readonly T[], f: FilterSet) => readonly T[], keyOf: (row: T) => number | string,
): Record<string, number> {
  const out: Record<string, number> = {};
  let seq = 0;
  for (const p of presets) {
    const f = presetToFilterSet(p, () => `c${++seq}`);
    const seen = new Set<number | string>();
    for (const pool of pools) for (const row of rowsOf(pool, f)) seen.add(keyOf(row));
    out[p.id] = seen.size;
  }
  return out;
}

/** The nth preset (1-based) for Alt+1..9. */
export const nthPreset = (list: readonly Preset[], n: number): Preset | undefined => list[n - 1];

/**
 * What a preset keeps, in a line: "Card status is Pre QA · Card assignee is not
 * Ben Ortiz". Field labels come from the board when it offers the field and
 * fall back to the stored key; the join is said once, between the rules.
 */
export function summarizeRules(join: "and" | "or", rules: readonly PresetRule[], fields: readonly FieldSpec[]): string {
  const word = join === "or" ? " or " : " and ";
  const parts = rules.map((r) => {
    const label = fields.find((f) => f.key === r.field)?.label ?? r.field;
    const op = OPS.find((o) => o.value === r.op)?.label ?? r.op;
    return takesValues(r.op) ? `${label} ${op} ${r.values.join(", ")}` : `${label} ${op}`;
  });
  return parts.length > 1 && join === "or" ? parts.join(word) : parts.join(" \u00b7 ");
}
