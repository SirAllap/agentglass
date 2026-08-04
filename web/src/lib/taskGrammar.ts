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

/*
 * Checklists inside a note.
 *
 * `() thing` and `(x) thing`, with an optional bullet — the shape the editor's
 * own note buffer writes, and the reason it is this and not `- [ ]`: these
 * notes already exist in the store, written by hand over months, and a list
 * that only understood markdown's spelling would render every one of them as
 * text. The format is the user's; this reads it.
 *
 * Unchecked is written back as `()` rather than `( )` for the same reason —
 * that is what the editor emits, and a toggle here must not quietly restyle a
 * note the next `git diff` of a synced store would show as changed.
 */
const BOX = /^(\s*(?:[-*]\s+)?)\(\s*([xX]?)\s*\)\s(.*)$/;

export interface CheckLine { checked: boolean; label: string }

/** The checkbox on this line, or null if the line is ordinary prose. */
export function checkbox(line: string): CheckLine | null {
  const m = BOX.exec(line);
  if (!m) return null;
  return { checked: m[2]!.toLowerCase() === "x", label: m[3]! };
}

/**
 * The whole note back, with one line flipped.
 *
 * A note is replaced wholesale (denotate then annotate), so the caller needs
 * the new text of the ENTIRE note, not of the line — returning the line would
 * push the reassembly, and the chance to lose the rest of it, to the call site.
 * Null when that line is not a checkbox, so nothing is written on a stray
 * click.
 */
export function toggleCheckbox(note: string, index: number): string | null {
  const lines = note.split("\n");
  const line = lines[index];
  if (line === undefined) return null;
  const m = BOX.exec(line);
  if (!m) return null;
  lines[index] = `${m[1]}(${m[2]!.toLowerCase() === "x" ? "" : "x"}) ${m[3]}`;
  return lines.join("\n");
}

/** How many of a note's checkboxes are done, for a count on the row. */
export function checkProgress(notes: string[]): { done: number; total: number } {
  let done = 0, total = 0;
  for (const n of notes) for (const line of n.split("\n")) {
    const c = checkbox(line);
    if (c) { total++; if (c.checked) done++; }
  }
  return { done, total };
}

/**
 * Which checkout a local task is about.
 *
 * Taskwarrior has nowhere to put this — there is no field for "the repository"
 * and adding a UDA would mean writing to the user's `~/.taskrc`, which this app
 * does not do. So it is inferred, and only from something the user actually
 * typed: `project:agentglass` names a repo called agentglass. Matching is
 * case-insensitive and also accepts the LAST segment of a dotted project,
 * because `@work.agentglass` is how a hierarchy is spelled here.
 *
 * The fallback is the checkout the panel is already pointed at — the same
 * "here" the rest of the app means by it. When there is nothing at all, null:
 * opening a shell in an arbitrary directory because we had to pick one is worse
 * than saying there is nowhere to open it.
 */
export function rootForTask(
  project: string | null, repos: { root: string; name: string }[], fallback: string | null,
): string | null {
  const want = (project ?? "").trim().toLowerCase();
  if (want) {
    const tail = want.split(".").pop()!;
    const hit = repos.find((r) => r.name.toLowerCase() === want)
      ?? repos.find((r) => r.name.toLowerCase() === tail);
    if (hit) return hit.root;
  }
  return fallback || null;
}

/**
 * What to hand an agent that is being asked about a task.
 *
 * The task as the user wrote it, not a paraphrase — description, then whatever
 * they put in the notes, which is where the actual detail lives. No instruction
 * to do anything: this lands in a composer that has not been sent, and deciding
 * what to ask for is the user's half of that.
 */
export function taskPrompt(t: { description: string; project: string | null; tags: string[]; notes: string[] }): string {
  const head = [t.description];
  const meta = [t.project ? `project: ${t.project}` : "", t.tags.length ? `tags: ${t.tags.join(", ")}` : ""]
    .filter(Boolean).join(" · ");
  if (meta) head.push(meta);
  const body = t.notes.filter((n) => n.trim()).join("\n\n");
  return body ? `${head.join("\n")}\n\n${body}` : head.join("\n");
}

/**
 * Every key the local list answers to, in one place.
 *
 * This array IS the legend on screen, and a test reads it against the branches
 * of the handler: a key advertised here with nothing behind it, or a key in the
 * handler nobody is told about, fails the build. A keyboard model nobody can
 * discover is the same as not having one — which is what this panel was until
 * the shortcuts had somewhere to be printed.
 *
 * `keys` is a list rather than a string with slashes in it, because one of the
 * keys IS a slash and splitting on it produced two keys named "".
 */
export const TASK_KEYS: { keys: string[]; what: string }[] = [
  { keys: ["j", "k"], what: "move" },
  { keys: ["g", "G"], what: "first / last" },
  { keys: ["Tab"], what: "mark and move on" },
  { keys: ["Enter"], what: "complete or reopen" },
  { keys: ["e"], what: "edit in the bar" },
  { keys: ["p"], what: "priority" },
  { keys: ["r"], what: "remind me" },
  { keys: ["t", "v"], what: "copy tags / paste them" },
  { keys: ["s"], what: "sort" },
  { keys: ["f"], what: "clear the filter" },
  { keys: ["w"], what: "shell here" },
  { keys: ["c"], what: "ask Claude" },
  { keys: ["d"], what: "delete" },
  { keys: ["/"], what: "the bar" },
  { keys: ["Escape"], what: "back to the bar, drop the marks" },
];
