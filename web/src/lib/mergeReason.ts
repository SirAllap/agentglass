// Why a pull request cannot be merged, said from what is actually true.
//
// GitHub's mergeable state is a single enum and it is coarser than the sentence
// people need. `UNSTABLE` means "a check is failing OR still running", and the
// panel translated it to "A check is failing" every time — so a pull request
// with 46 green checks and two still going was reported as failing, in a box
// whose very next line said "46 checks passed".
//
// Contradicting yourself inside one box is worse than saying nothing: the
// reader now has to work out which half to believe, and the half that says
// "failing" is the one that sends them to the browser.
//
// So the enum is the fallback, not the answer. The rollup already knows how
// many are red and how many are pending, and it is the same rollup the Checks
// tab renders — which is why that tab said "0 failing" while the header said
// the opposite.

import type { PrCheckRollup } from "../../../shared/types.ts";

/** The generic sentence for each state, used when the checks cannot say more. */
export const MERGE_WHY: Record<string, string> = {
  BLOCKED: "A required review or check has not passed",
  BEHIND: "The base branch has moved — update the branch first",
  DIRTY: "There are conflicts with the base branch",
  UNSTABLE: "A check has not passed",
  DRAFT: "This is a draft",
  HAS_HOOKS: "A repository hook is blocking the merge",
  UNKNOWN: "GitHub has not finished working it out",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What to say under "Merging is blocked".
 *
 * Order matters and it is the order of what would stop you: something red is
 * the reason whatever else is true; then something still running, which is a
 * reason to WAIT rather than to act, and saying so is the difference between
 * "go and fix it" and "go and get a coffee"; then whatever GitHub said.
 *
 * `DIRTY` and `BEHIND` come first of all, because they are about the branch
 * rather than the checks: a conflicted pull request whose checks are still
 * running is blocked by the conflict, and "checks are still running" would be
 * true and useless.
 */
export function mergeBlockedWhy(state: string, c: PrCheckRollup | null | undefined): string {
  if (state === "DIRTY" || state === "BEHIND" || state === "DRAFT") {
    return MERGE_WHY[state]!;
  }
  if (c) {
    if (c.failure > 0) {
      const names = c.failing.slice(0, 2).map((f) => f.name).join(", ");
      const rest = c.failing.length > 2 ? ` +${c.failing.length - 2} more` : "";
      // Named, because a count alone is what sends people to the browser.
      return names ? `${names}${rest} failing` : `${plural(c.failure, "check")} failing`;
    }
    if (c.pending > 0) {
      return `${plural(c.pending, "check")} still running — nothing has failed`;
    }
  }
  return MERGE_WHY[state] ?? "Not mergeable";
}

/**
 * The green line under it: what the checks add up to.
 *
 * Returns null when there is nothing worth saying — no checks at all, or
 * something red, which the line above has already named.
 *
 * The pending case is why this exists. "46 checks passed" while two are still
 * running is not false and it is not the whole truth, and it was being drawn
 * directly underneath a header that said merging was blocked.
 */
/**
 * How many of them were actually skipped.
 *
 * The rollup's `total` counts skipped, stale and neutral runs alongside the
 * ones that ran, so `total` is never the number that passed.
 */
export const skippedIn = (c: PrCheckRollup): number =>
  Math.max(0, c.total - c.success - c.failure - c.pending);

export function checksLine(
  c: PrCheckRollup | null | undefined,
  noConflictsWith?: string,
  /** GitHub capped the contexts page. Then every number here is about the page
   *  that came back, not about the pull request, and it has to say so. */
  capped?: boolean,
): string | null {
  if (!c || c.total === 0 || c.failure > 0) return null;
  const tail = noConflictsWith ? `, no conflicts with ${noConflictsWith}` : "";
  /*
   * `success`, never `total` — a repository with path-filtered jobs read "45
   * checks passed" when forty had run and five had been skipped. That was fixed
   * in the field strip and NOT here, so the same cell's body and its own
   * tooltip disagreed by five checks, and Overview repeated the tooltip's
   * version. One generator now, and skipped is said rather than absorbed.
   */
  const skipped = skippedIn(c);
  const also = skipped > 0 ? `, ${plural(skipped, "check")} skipped` : "";
  /* No number on the cap: `total` is the size of the page that came back, so
     "of the first 130" would be arithmetic about the wrong set. */
  const page = capped ? " of the page GitHub returned" : "";
  if (c.pending > 0) {
    return `${plural(c.success, "check")} passed, ${plural(c.pending, "check")} still running${also}${page}${tail}`;
  }
  return `${plural(c.success, "check")} passed${also}${page}${tail}`;
}

/**
 * Will GitHub take it, and if not, why not — asked once for every surface.
 *
 * This ladder existed twice: in Overview and, copied, in the file rail. The
 * rail's own comment said a short version reaching a different verdict from the
 * long one "is not short, it is a second opinion" — and within the day they
 * were a second opinion on two of three cases. With a CLEAN pull request whose
 * checks were still running, Overview said "Nothing is blocking it" with an
 * empty subtitle and the rail, one tab away, said "Waiting for the checks".
 *
 * `blocked` is separate from the sentence so a surface can keep its own
 * headline for the blocked case — Overview has room for "Behind the base
 * branch" where a 320px column does not — without either of them re-deriving
 * WHETHER it is blocked.
 */
export function mergeVerdict(
  state: string,
  c: PrCheckRollup | null | undefined,
  awaited = false,
): { line: string; blocked: boolean } {
  if (state !== "CLEAN") return { line: mergeBlockedWhy(state, c), blocked: true };
  const standing = checksStanding(c, awaited);
  if (standing === "green") return { line: "Ready to merge", blocked: false };
  /* Red and CLEAN together is not a contradiction: it is GitHub saying those
     checks are not required, and that is the difference between a button you
     should not press and one you can. */
  if (c && c.failure > 0) {
    return { line: `${c.failure} failing, and GitHub is not requiring ${c.failure === 1 ? "it" : "them"}`, blocked: false };
  }
  if ((c && c.pending > 0) || standing === "awaiting") return { line: "Waiting for the checks", blocked: false };
  return { line: "Nothing is blocking it", blocked: false };
}

/**
 * The same fact in the width of one cell.
 *
 * The field strip has nine cells on one row and cannot carry the sentence, so
 * it had its own ladder — and the two immediately drifted, which is the whole
 * reason this lives beside `checksLine` instead of inside a component.
 */
export function checksShort(c: PrCheckRollup | null | undefined, capped?: boolean): string | null {
  if (!c || c.total === 0) return null;
  const skipped = skippedIn(c);
  const page = capped ? " of the page returned" : "";
  if (c.failure > 0) return null; // the caller names what failed instead
  if (c.pending > 0) return `${c.success + skipped}/${c.total} in${page}`;
  return `${c.success} passed${skipped > 0 ? ` · ${skipped} skipped` : ""}${page}`;
}

/**
 * Zero checks is two different facts wearing one shape.
 *
 * Either this repository runs nothing on this pull request, or the head commit
 * moved a moment ago and no run has been created yet. The rollup cannot tell
 * them apart from one sample, and the panel was reading it as the first and
 * saying "Ready to merge — nothing is standing in the way" over a pull request
 * GitHub was already reporting three checks in progress on.
 *
 * That is the worst version of wrong here, because it is the state right after
 * pressing "Update branch": the push starts CI, and for the seconds between the
 * push landing and the first run appearing, an empty rollup looks exactly like
 * a green one.
 *
 * So: never claim nothing is standing in the way on the strength of an empty
 * list. `awaited` is what the caller knows and this cannot — that it just
 * pushed to the branch, so runs are expected — and it turns a calm "none have
 * reported" into "waiting for them to start".
 */
export type ChecksStanding = "green" | "none-reported" | "awaiting" | "mixed";

export function checksStanding(
  c: PrCheckRollup | null | undefined,
  awaited = false,
): ChecksStanding {
  if (!c || c.total === 0) return awaited ? "awaiting" : "none-reported";
  if (c.failure > 0 || c.pending > 0) return "mixed";
  return "green";
}

/** What the line under the header says about it. Null where the lines above
 *  have already said it — see checksLine. */
export function standingLine(s: ChecksStanding, base?: string): string | null {
  if (s === "awaiting") {
    return "The branch just moved — waiting for the checks to start. GitHub creates them a few seconds after the push.";
  }
  if (s === "none-reported") {
    // Calm, not alarming: a repository with no CI is a real and fine thing.
    // What is not fine is calling it "nothing is standing in the way".
    return `No checks have reported on this commit${base ? `, no conflicts with ${base}` : ""}`;
  }
  return null;
}
