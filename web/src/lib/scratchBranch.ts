/**
 * Branches that were made to read something, not to build something.
 *
 * Reviewing a pull request locally leaves a branch behind, and after a few
 * months of it a branch list is mostly litter. The ask was to mark them —
 * carefully, because a branch list is where people decide what to delete and a
 * wrong mark there costs somebody a day of work.
 *
 * So the rule is deliberately narrow, and it is a rule about SHAPE. It was
 * tempting to say "the ones this app creates", and that turned out to be false:
 * nothing here writes these names. `gh pr checkout` does, and so does whichever
 * agent is following a review prompt. What makes the shape safe is not who typed
 * it — it is that a pull request number is the whole name. A branch called
 * `pr-1042-review` states that it exists to look at PR 1042 and says nothing
 * about what is on it. Real work is named after the work.
 *
 * Everything else that looked like litter is deliberately NOT matched. A repo
 * had `_x_probe`, `qbase`, `simprb`, `backup/…` — plainly scratch to the
 * person who made them, and unrecognisable to us. A branch nobody can classify
 * is a branch we say nothing about.
 */

/**
 * `pr-1042-review`, `pr1042-review`, `pr-1042-local`, `pr/1042-review`, `pr-1042`.
 *
 * The separators are optional because every spelling turns up in the same repo,
 * typed by different tools on different days. The suffix is optional too, and
 * working out why is what made the rule right: the suffix was never what made
 * the name safe to classify. `pr-1042` on its own is a name made of a pull
 * request number and nothing else, which is the whole argument — it says which
 * pull request and nothing about the work.
 *
 * Measured before widening it: two such branches in a working repository
 * carried 2 and 4 commits of their own, so the mark cannot claim there is
 * nothing on them. It does not — it is a statement about the NAME, and that
 * statement stays true of a branch somebody went on to commit to.
 *
 * What is still required is that the number be the whole name.
 * `release-2024-local` is not a pull request, and `ORBIT-1042-review` says what
 * it is about.
 */
const SCRATCH = /^pr[-_/]?(\d+)(?:[-_](?:review|local))?$/i;

/** The pull request a scratch branch was cut to read, or null if it is not one. */
export function scratchPr(branch: string): number | null {
  const m = SCRATCH.exec(branch.trim());
  if (!m) return null;
  const n = Number(m[1]);
  /* A number git accepted but nobody would issue. Guarding it costs nothing and
     keeps `#0` off the screen. */
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const isScratchBranch = (branch: string): boolean => scratchPr(branch) !== null;

/** What the row says about it, with the number so the mark can be checked
 *  against GitHub rather than trusted.
 *
 *  Worded about the NAME, deliberately. "Nothing on it" was the first wording
 *  and it was false: measured, two of these carried commits of their own. */
export function scratchNote(branch: string): string {
  const n = scratchPr(branch);
  return n === null ? "" : `Named after pull request #${n} and nothing else — a local checkout of it`;
}
