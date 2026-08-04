/*
 * The bar's grammar, and the order the list is in.
 *
 * Pure, and in its own file for two reasons. The server is the one that decides
 * what a write means, so this only has to be honest about what it is *going* to
 * say — which is what the user reads before pressing Enter. And a component
 * file drags `api.ts` in with it, which touches `location` at module scope and
 * cannot be imported by a test without a DOM.
 */
import type { LocalTask } from "../../../shared/types.ts";

/** The orders worth having, in the order somebody cycles them. */
export type SortMode = "reminder" | "due" | "priority" | "created";
export const SORTS: SortMode[] = ["reminder", "due", "priority", "created"];

/**
 * Sorting, with one rule that is not obvious: a task with nothing in the field
 * being sorted on goes last, not first. An empty due date is not "very soon".
 */
export function sortTasks(list: LocalTask[], mode: SortMode): LocalTask[] {
  const W = { H: 3, M: 2, L: 1 } as const;
  const key = (t: LocalTask): [number, string] => {
    if (mode === "due") return [t.due ? 0 : 1, t.due ?? ""];
    if (mode === "priority") return [t.priority ? 0 : 1, String(9 - (W[t.priority ?? "L"] ?? 0))];
    if (mode === "created") return [0, t.created ? String(9e12 - Date.parse(t.created)) : "9"];
    return [0, ""]; // reminder order is applied by the caller's map, which the server already sorted
  };
  return [...list].sort((a, b) => {
    const [ax, ay] = key(a), [bx, by] = key(b);
    return ax - bx || ay.localeCompare(by);
  });
}

/**
 * A task, written back out in the language it was typed in.
 *
 * This is what makes `e` an edit rather than a retype: the line that comes back
 * is one the same parser would turn into the same task. Anything the grammar
 * cannot say is left out of the line and, because the edit verb never mentions
 * it either, left alone in the store.
 */
export function toLine(t: LocalTask): string {
  const bits = [t.description];
  if (t.priority) bits.push(`!${t.priority.toLowerCase()}`);
  for (const tag of t.tags) bits.push(`+${tag}`);
  if (t.project) bits.push(`@${t.project}`);
  if (t.due) bits.push(`due:${t.due}`);
  return bits.join(" ");
}



/**
 * The same grammar the server parses, for the strip above.
 *
 * Duplicated deliberately and kept small: the server is the one that decides
 * what a write means, and this only has to be honest about what it is going to
 * say. A shared module would drag the server's Bun imports into the bundle.
 */
export function parseLocal(input: string): { description: string; priority: string | null; tags: string[]; project: string | null; due: string | null } {
  const out = { description: "", priority: null as string | null, tags: [] as string[], project: null as string | null, due: null as string | null };
  let s = input.replace(/\*([^*]+)$/u, " ");
  s = s.replace(/(?:^|\s)!([hmlHML])(?=\s|$)/gu, (_, p: string) => { out.priority = p.toUpperCase(); return " "; });
  s = s.replace(/(?:^|\s)#(\d{1,4})(?=\s|$)/gu, (_, n: string) => {
    const d = new Date(); d.setDate(d.getDate() + Number(n));
    const q = (x: number) => String(x).padStart(2, "0");
    out.due = `${d.getFullYear()}-${q(d.getMonth() + 1)}-${q(d.getDate())}`;
    return " ";
  });
  s = s.replace(/(?:^|\s)due:(\d{4}-\d{2}-\d{2})(?=\s|$)/gu, (_, d: string) => { out.due = d; return " "; });
  s = s.replace(/(?:^|\s)\+([^\s]+)/gu, (m: string, t: string) =>
    /^[\p{L}\p{N}_-]{1,40}$/u.test(t) ? (out.tags.push(t), " ") : m);
  s = s.replace(/(?:^|\s)@([^\s]+)/gu, (m: string, p: string) =>
    /^[\p{L}\p{N}._-]{1,60}$/u.test(p) ? ((out.project = p), " ") : m);
  out.description = s.replace(/\s+/gu, " ").trim();
  return out;
}


/**
 * Where the selection lands after a step, given where it is now.
 *
 * Extracted from the key handler for one reason: the interesting case is the
 * one with nothing selected yet, and it is off by one in the obvious version.
 * Treating "no selection" as row 0 and then adding the step opens the list on
 * the SECOND row, and the first cannot be reached without arrowing back — a
 * bug that survived because it looks right and nothing could assert on it.
 *
 * With no selection the first press lands on an end: `j` on the first row, `k`
 * on the last. Both ends clamp rather than wrap; a list that jumps from bottom
 * to top under a held key is disorienting where a stop is not.
 */
export function step(at: number, n: number, len: number): number {
  if (len <= 0) return -1;
  const from = at < 0 ? (n > 0 ? -1 : len) : at;
  return Math.max(0, Math.min(len - 1, from + n));
}
