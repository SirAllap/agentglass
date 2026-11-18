import type { Trigger } from "../../../../shared/orchestration.ts";

/** The sections of the rule sheet, top to bottom. One place decides the order. */
export const SHEET_SECTIONS = ["when", "then", "preview", "test"] as const;

/** The value controls a condition of this kind shows after its kind select, left to right. */
export function conditionFields(kind: Trigger["kind"]): ("plan" | "window" | "pct" | "days" | "time")[] {
  switch (kind) {
    case "usage": return ["plan", "window", "pct"];
    case "limit": return ["plan"];
    case "hours": return ["days", "time"];
    default: return [];
  }
}

/** A job has exactly one "Add a step" control, at the end of its list; a full chain disables it. */
export function addStepState(count: number, max: number): { shown: true; disabled: boolean } {
  return { shown: true, disabled: count >= max };
}
