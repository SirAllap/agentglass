/*
 * THE OLD LOCAL PRESETS, read-only. Saved filter sets used to live in
 * localStorage per repository; they are views on the server now
 * (prViewsStore.ts), and this file is what reads the old copy once to import
 * it, plus the name rules a view shares with them (a name may not be empty,
 * longer than MAX_NAME, or taken; case does not count).
 */
import type { Op } from "../components/tasks/filters.ts";

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


export type NameVerdict = { ok: true; name: string } | { ok: false; reason: "empty" | "long" | "taken"; name: string };

/** Is this a name the list can take? `exceptId` is the preset being renamed, so
 *  it does not collide with itself. Case does not count: "mine" is "Mine". */
export function checkName(raw: string, list: readonly Pick<Preset, "id" | "name">[], exceptId?: string): NameVerdict {
  const name = cleanName(raw);
  if (!name) return { ok: false, reason: "empty", name };
  if (name.length > MAX_NAME) return { ok: false, reason: "long", name };
  const k = name.toLowerCase();
  if (list.some((p) => p.id !== exceptId && p.name.toLowerCase() === k)) return { ok: false, reason: "taken", name };
  return { ok: true, name };
}

/** "Name", then "Name 2", "Name 3"…, shortened so the suffix still fits. */
export function freeName(base: string, list: readonly Pick<Preset, "id" | "name">[]): string {
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
