/*
 * The strings ClickUp's own GitHub panel hands you, built here.
 *
 * Its "Quick Start" is four fields with a copy button each — the task id, a
 * branch name, the checkout command, a commit line — and it is what makes the
 * link between a card and a branch work at all: the id in the branch name is
 * what ClickUp looks for later, and what this app's own search looks for (see
 * mentionsCard).
 *
 * Copied to the letter rather than improved on, because the FORM is the
 * contract: a branch named any other way stops being found by either side.
 */

/**
 * The title, as a branch fragment.
 *
 * ClickUp's rule, read off its own output: spaces and punctuation become single
 * hyphens, the case of the words is kept, and nothing else is touched. So
 * "Alarm | Caller number not found" becomes "Alarm-Caller-number-not-found"
 * — no lowercasing, which is the detail everybody who re-implements this gets
 * wrong.
 */
export function titleSlug(title: string): string {
  return title
    .normalize("NFKD")
    // Anything that is not a letter, a digit or an underscore is a separator.
    // Accented letters survive the normalise above as letter + mark, and the
    // mark goes here, so "Menú" is "Menu" rather than "Men".
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}

/** `ORBIT-1042-Alarm-Caller-number-not-found-…`. The id first: that is what
 *  makes it findable, and it is the half that must never be dropped. */
export function branchName(cardId: string, title: string): string {
  const id = cardId.trim();
  const slug = titleSlug(title);
  return id && slug ? `${id}-${slug}` : id || slug;
}

/** What ClickUp offers to paste into a shell. Quoted, because a branch name
 *  with anything odd left in it would otherwise be several arguments. */
export const checkoutCommand = (cardId: string, title: string): string =>
  `git checkout -b "${branchName(cardId, title)}"`;

/**
 * The commit line, in the form that links the commit to the card.
 *
 * `ORBIT-1042 - Alarm | Caller number not found…` — the id, a dash, and the
 * title as it reads, NOT slugged. That is what ClickUp shows and what its own
 * commit scanner matches.
 */
export const commitCommand = (cardId: string, title: string): string =>
  `git commit -m "${cardId.trim()} - ${title.replace(/"/g, "'").trim()}"`;

/** The worktree this app would cut for that branch, beside the checkout it is
 *  in — the same shape the rest of the app uses for one. */
export const worktreeCommand = (repoRoot: string, cardId: string, title: string): string => {
  const branch = branchName(cardId, title);
  const parent = repoRoot.replace(/\/+$/, "");
  const name = `${parent.split("/").pop() || "repo"}-${cardId.trim() || "work"}`;
  return `git -C "${parent}" worktree add -b "${branch}" "../${name}"`;
};
