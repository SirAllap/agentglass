// Pure helpers for the Inspect and Advanced pages: what kind a stored value is (so it can be drawn by kind),
// the launch-flags table, and the split of a "when you would touch it" line. No DOM, so tests need none.
import { LAUNCH_MODES, LAUNCH_MODE_LABEL, type LaunchMode } from "../../../../../shared/launchModes.ts";

export type ValueKind = "empty" | "boolean" | "enum" | "list" | "object" | "long" | "text";

const ENUM_LABEL: Record<string, string> = { ...LAUNCH_MODE_LABEL, dontAsk: "Don't ask", readOnly: "Read-only" };
/** The human label of a known enum value, or null when the string is not one. */
export const enumLabel = (v: unknown): string | null => (typeof v === "string" && Object.hasOwn(ENUM_LABEL, v) ? ENUM_LABEL[v]! : null);

export const LONG_AT = 80;

export function valueKind(v: unknown): ValueKind {
  if (v === undefined || v === null || v === "") return "empty";
  if (Array.isArray(v)) return v.length === 0 ? "empty" : v.every((x) => typeof x === "string") ? "list" : "object";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "object") return Object.keys(v as object).length === 0 ? "empty" : "object";
  if (typeof v === "string") return enumLabel(v) ? "enum" : v.length > LONG_AT ? "long" : "text";
  return "text";
}

/** "12 keys" / "1 key": the closed form of an object value. */
export const keyCount = (v: unknown): string => {
  const n = Array.isArray(v) ? v.length : Object.keys((v ?? {}) as object).length;
  return `${n} ${Array.isArray(v) ? (n === 1 ? "item" : "items") : n === 1 ? "key" : "keys"}`;
};

export interface FlagsTable {
  modes: { id: LaunchMode; label: string }[];
  rows: { engine: string; cells: string[][] }[];
}

/** The launch-flags rows (one per engine, value = flags per mode) as one table: engines down, modes across. A cell with no flags is []. */
export function flagsTable(rows: { engine: string; value: unknown }[]): FlagsTable {
  return {
    modes: LAUNCH_MODES.map((id) => ({ id, label: LAUNCH_MODE_LABEL[id] })),
    rows: rows.map(({ engine, value }) => {
      const m = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      return {
        engine,
        cells: LAUNCH_MODES.map((id) => {
          const f = m[id];
          return Array.isArray(f) ? f.map(String).filter(Boolean) : typeof f === "string" ? f.split(/\s+/).filter(Boolean) : [];
        }),
      };
    }),
  };
}

/** Splits "What it does. Only when X." into what it does and the reason to touch it. No "Only" sentence: all help, no reason. */
export function splitTouch(touch: string): { what: string; when: string | null } {
  const parts = touch.split(/(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
  const i = parts.findIndex((s) => /^only\b/i.test(s));
  if (i < 0 || parts.length === 1) return { what: touch, when: null };
  const m = /^only\s+((?:when|if)\s+)?(.*?)\.?$/i.exec(parts[i]!)!;
  const when = `${m[1] ?? ""}${m[2]}`;
  return { what: parts.filter((_, j) => j !== i).join(" "), when: when.charAt(0).toUpperCase() + when.slice(1) };
}
