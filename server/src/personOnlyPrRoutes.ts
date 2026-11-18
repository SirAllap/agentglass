/**
 * The pull request writes only the person makes: a merge, arming auto-merge
 * (it merges later, with nobody pressing anything), and a close (`/prs/close`
 * and Unstick's close), and approving a contributor's held workflow runs. The
 * merge lock covers a locked pull request; this covers every other one, so a worker's token cannot merge through the panel's
 * own route.
 *
 * `person` is the same test as the merge lock and Go/No-go (`mayPublishReview`
 * in index.ts): the person's own window, or a paired phone with the full grant.
 * Cancelling an armed auto-merge stays open to anyone, as in mergePr and the
 * gate's lock check: it stops a merge, it never makes one.
 */
export const MERGE_REFUSED = "Only the person merges; an agent cannot.";
export const CLOSE_REFUSED = "Only the person closes a pull request; an agent cannot.";
/** Approving a contributor's held workflows runs their code on this repository's runners. */
export const APPROVE_RUNS_REFUSED = "Only the person approves a contributor's workflows to run; an agent cannot.";

export function personOnlyPrRefusal(pathname: string, b: Record<string, unknown>, person: boolean): { ok: false; error: string; status: 403 } | null {
  if (person) return null;
  if (pathname === "/prs/merge") {
    if (b.disableAuto === true || b.disableAuto === "true") return null;
    return { ok: false, error: MERGE_REFUSED, status: 403 };
  }
  if (pathname === "/prs/close" || pathname === "/prs/unstick-close") return { ok: false, error: CLOSE_REFUSED, status: 403 };
  if (pathname === "/prs/approve-runs") return { ok: false, error: APPROVE_RUNS_REFUSED, status: 403 };
  return null;
}
