import type { GitFileChange } from "../../../shared/types.ts";

export interface ReviewRow {
  path: string;
  /** The staged change, when there is one — see below for when there is not. */
  change?: GitFileChange;
  /** Somebody chose what this file should contain. */
  decided: boolean;
}

/**
 * Everything the merge commit would carry, conflicted files first.
 *
 * Not simply the staged list, and that is the whole point of it existing.
 *
 * Found by driving the real screen rather than by thinking about it: resolve a
 * conflict in favour of the side you are already on, and the file becomes
 * identical to HEAD. No diff — so `git diff --cached` does not mention it, and
 * it is absent from everything built on that list. The review then showed
 * thirty untouched files under the sentence "2 of these you decided", and
 * neither of the two was on it.
 *
 * The commit records a resolution for that path either way, and it is still a
 * decision a person made. So the list is built from the merge's own record of
 * what conflicted, with the staged change attached where there is one, and the
 * rest of the staged files after it.
 */
export function reviewRows(root: string, decided: string[], staged: GitFileChange[]): ReviewRow[] {
  // The working tree reports absolute paths; the merge record keeps them
  // relative to the root. Comparing the two forms directly lists every
  // conflicted file twice.
  const rel = (c: GitFileChange) => (c.file_path.startsWith(root) ? c.file_path.slice(root.length + 1) : c.file_path);
  const was = new Set(decided);
  const byPath = new Map(staged.map((c) => [rel(c), c]));
  return [
    ...decided.map((f) => ({ path: f, change: byPath.get(f), decided: true })),
    ...staged.filter((c) => !was.has(rel(c))).map((c) => ({ path: rel(c), change: c, decided: false })),
  ];
}
