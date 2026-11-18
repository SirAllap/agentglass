/*
 * The order of a view's status columns never changes on its own. The last order the server gave for a view is kept
 * per view and read at boot, so the first paint already has it; a later answer with the same statuses (in any order)
 * keeps it, and only a workflow that really changed (a status added or removed) takes the answer's order.
 */
import type { ListStatus } from "../../../shared/providers.ts";

type Store = Pick<Storage, "getItem" | "setItem">;
const KEY = "agx.jira.columnOrder.";
const lower = (s: string) => s.toLowerCase();

export function readOrder(view: string, store?: Store): string[] | null {
  try {
    const raw = (store ?? localStorage).getItem(KEY + view);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  } catch { return null; }
}

export function writeOrder(view: string, order: readonly string[], store?: Store): void {
  try { (store ?? localStorage).setItem(KEY + view, JSON.stringify(order)); } catch { /* private mode */ }
}

/** The answer's statuses, in the stored order when they are the same statuses; the answer's own order when the workflow changed. */
export function settleOrder(stored: readonly string[] | null, answer: readonly ListStatus[]): ListStatus[] {
  if (!stored?.length || stored.length !== answer.length) return [...answer];
  const by = new Map(answer.map((s) => [lower(s.status), s]));
  if (by.size !== answer.length || !stored.every((n) => by.has(lower(n)))) return [...answer];
  return stored.map((n, i) => ({ ...by.get(lower(n))!, orderindex: i }));
}
