// The rules behind the danger and conflict dialogs of lot 4, kept out of the
// screens so they can be tested (there is no renderer in this project).

/** A button that is held may not be pressed, by click or by Enter. */
export const holdBlocks = (held: boolean, disabled?: boolean): boolean => !!disabled || held;

export interface LostList { shown: string[]; more: number; line: string }

/** What will be lost, as a short list and one plain sentence. Never more than
 *  `max` names: the rest is a count, so the dialog keeps its height. */
export function lostList(items: readonly string[], noun: string, max = 4): LostList {
  const shown = items.slice(0, max);
  const more = Math.max(0, items.length - shown.length);
  const n = items.length;
  const line = n === 0 ? `Nothing you wrote here is lost.` : `${n} ${noun}${n === 1 ? "" : "s"} you answered here go${n === 1 ? "es" : ""}.`;
  return { shown, more, line };
}

/** The abandon question's words: what is lost, in plain terms. */
export function abandonLost(resolved: readonly string[]): LostList & { body: string } {
  const l = lostList(resolved, "file");
  const body = resolved.length
    ? `The tree goes back to exactly how it was. There is no undo.`
    : `The tree goes back to exactly how it was. You have not answered anything yet.`;
  return { ...l, body };
}

/** Files a merge abort really drops: every file git has as resolved, whoever
 *  resolved it (in the app, in an editor, or staged by hand). */
export const resolvedFiles = (files: readonly string[], left: readonly string[]): string[] => files.filter((f) => !left.includes(f));

/** What Discard drops: the uncommitted changes in one file, not "answers". */
export function discardLostLine(file: string, changes: number): string {
  return changes > 0 ? `${changes} uncommitted change${changes === 1 ? "" : "s"} in ${file} go.` : `Uncommitted changes in ${file} go.`;
}

/** Tracked files with uncommitted work: what `reset --hard` overwrites. Untracked files stay. */
export function dirtyTracked<C extends { status: string }>(tree: { staged: readonly C[]; unstaged: readonly C[] } | null | undefined, rel: (c: C) => string): string[] {
  const all = [...(tree?.staged ?? []), ...(tree?.unstaged ?? [])].filter((c) => c.status !== "untracked").map((c) => rel(c));
  return [...new Set(all)];
}

/** The whole hard-reset loss: dropped commits first, then uncommitted files.
 *  Null only when there is nothing to say. `commits` null = target not in the
 *  window read; then only the files are named. */
export function hardResetLost(commits: readonly string[] | null, dirty: readonly string[]): { items: string[]; line: string } | null {
  const c = commits ?? [];
  const items = [...c, ...dirty];
  if (!items.length && commits) return null;
  const parts: string[] = [];
  if (c.length) parts.push(`${c.length} commit${c.length === 1 ? " is" : "s are"} dropped from this branch`);
  if (dirty.length) parts.push(`${dirty.length} uncommitted file${dirty.length === 1 ? " is" : "s are"} overwritten`);
  if (commits === null) parts.push("Commits past the last 200 are not counted");
  return { items, line: parts.join(", ") + "." };
}

export interface ConflictRow { rel: string; places: number | null; settled: number | null; open: boolean }
export type Square = "settled" | "open" | "current";

/** "Which side wins in 3 files?" — the question leads; the bar reading
 *  "Merging ours ← incoming" is gone. */
export function conflictQuestion(left: number): string {
  if (left <= 0) return "Every conflict has an answer.";
  return `Which side wins in ${left} file${left === 1 ? "" : "s"}?`;
}

/** One square per conflicted file. A map past `cap` squares collapses to the
 *  numbers, so 70 files do not become 70 buttons. */
export function conflictSquares(rows: readonly ConflictRow[], current: string | null, cap = 70): Square[] {
  return rows.slice(0, cap).map((r) => (r.rel === current && r.open ? "current" : r.open ? "open" : "settled"));
}

export const settledLine = (rows: readonly ConflictRow[]): string =>
  `${rows.filter((r) => !r.open).length} of ${rows.length} files settled`;

/** The "1/3" at the end of a file row; a file not read yet shows no fraction. */
export const placesLabel = (r: ConflictRow): string =>
  r.places == null ? "" : !r.open ? `${r.places}/${r.places}` : `${r.settled ?? 0}/${r.places}`;

/** Footer sentence: what to do next, in one line. */
export function nextStep(o: { left: number; fileAnswered: number; fileTotal: number; commitWord: string }): string {
  if (o.left === 0) return `Every file is settled. Review, then ${o.commitWord}.`;
  if (o.fileTotal > 0 && o.fileAnswered < o.fileTotal) return `Answer the ${o.fileTotal - o.fileAnswered} open place${o.fileTotal - o.fileAnswered === 1 ? "" : "s"} in this file, then resolve it.`;
  if (o.fileTotal > 0) return `Resolve this file, then pick the next one.`;
  return `Pick a file on the left.`;
}

/** Commits a hard reset drops: the ones newer than the target. `log` is newest
 *  first, so they are everything before the target. Null when the target is
 *  not in the window read (then the dialog says nothing it cannot back up). */
export function resetLost(log: readonly { hash: string; shortHash: string; subject: string }[], target: string): { items: string[]; line: string } | null {
  const i = log.findIndex((c) => c.hash.startsWith(target) || target.startsWith(c.shortHash));
  if (i < 0) return null;
  const items = log.slice(0, i).map((c) => `${c.shortHash} ${c.subject}`);
  const n = items.length;
  const line = n === 0 ? "No commits are dropped. Only uncommitted changes go." : `${n} commit${n === 1 ? " is" : "s are"} dropped from this branch, and so are uncommitted changes.`;
  return { items, line };
}

/** "2 commits only here": what the delete confirm says about a branch's own commits. */
export const onlyHereLine = (n: number): string => n <= 0 ? "Every commit on it is also on another branch or on origin." : `${n} commit${n === 1 ? "" : "s"} on it ${n === 1 ? "is" : "are"} on no other branch and not on origin.`;

/** Files the user unticked that are staged in part (also listed as unstaged).
 *  Putting them back with a plain stage would stage the whole file, so the
 *  review refuses to untick them. */
export const partiallyStaged = (dropped: readonly string[], unstaged: readonly string[]): string[] => dropped.filter((f) => unstaged.includes(f));

/** Hard-reset words are shown when something is named, or when the commit loss is unknown. */
export const hardResetShows = (gone: { items: readonly string[] } | null, commits: readonly string[] | null): boolean => !!gone && (gone.items.length > 0 || commits === null);
