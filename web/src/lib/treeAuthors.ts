/**
 * Who a section of the Diff view is — the words for it.
 *
 * The server says which live sessions wrote into each checkout (see
 * server/src/sharedtree.ts). One author is the case the per-checkout grouping
 * is honest about, and the heading names it. More than one is the case it is
 * not: a change in the section can be any of theirs, and a file more than one
 * of them edited has a single diff on disk that nothing can split by author. That is
 * said on the heading and on the row, rather than left for the reader to infer
 * from a list that looks exactly as confident either way.
 *
 * Kept free of React so it can be tested without a renderer.
 */
import type { TreeAuthorsInfo } from "../../../shared/types.ts";

export function joinNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function authorsIndex(authors: TreeAuthorsInfo[] | undefined): {
  byRoot: Map<string, TreeAuthorsInfo>;
  /** By the list's own row key, `${root}\0${path}`: the authors of a file more
   *  than one live session edited. */
  byRow: Map<string, string[]>;
} {
  const byRoot = new Map<string, TreeAuthorsInfo>();
  const byRow = new Map<string, string[]>();
  for (const t of authors ?? []) {
    byRoot.set(t.root, t);
    // Which of them touched which file is not sent — only that more than one
    // did — so every author of the tree is named on an overlapping row. With
    // three authors and two of them on the file that names one too many, and
    // it is the honest reading of what is known.
    const names = t.sessions.map((s) => s.name);
    for (const p of t.overlap) byRow.set(`${t.root}\0${p}`, names);
  }
  return { byRoot, byRow };
}

/**
 * The authors of a section — only when the section IS a checkout.
 *
 * A day or a folder is not something one agent wrote, and naming one on it
 * would be a claim the grouping does not support. In worktree mode the section
 * key is the checkout's root.
 */
export function sectionAuthors(
  ix: ReturnType<typeof authorsIndex>, groupBy: string, sectionKey: string,
): TreeAuthorsInfo | undefined {
  return groupBy === "worktree" ? ix.byRoot.get(sectionKey) : undefined;
}

export function headingAuthors(t: TreeAuthorsInfo): { text: string; shared: boolean; title: string } {
  const names = t.sessions.map((s) => s.name);
  if (names.length < 2) {
    // "Is writing here", never "by": the rows are whatever git holds, and some
    // of them can be yesterday's uncommitted work by a session that has since
    // gone. What is known is who is live in this checkout, and that is all
    // the words claim.
    return {
      text: `${names[0] ?? "an agent"} is writing here`,
      shared: false,
      title: `${names[0] ?? "One agent"} is the only live session writing into this checkout.`,
    };
  }
  const n = t.overlap.length;
  return {
    text: `shared · ${names.length} sessions`,
    shared: true,
    title: `${joinNames(names)} are ${names.length === 2 ? "both" : "all"} writing into this checkout, so a change here can be any of theirs. `
      + (n
        ? `${n} file${n === 1 ? " has" : "s have"} been edited by more than one of them, and a diff on disk cannot say whose hunk is whose — per-file attribution here is approximate. `
        : "No file has been edited by more than one of them yet, so no file's diff is a mix of theirs. ")
      + "A worktree per agent keeps each section one agent's work.",
  };
}

export function rowAuthorsTitle(names: string[]): string {
  return `Edited by ${joinNames(names)}: this diff is their work together, and there is no telling whose hunk is whose.`;
}
