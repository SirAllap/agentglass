/*
 * What a pull request's row says, decided apart from the row.
 *
 * Three questions are answered on the row itself, because they decide whether
 * it is opened at all: is CI red, where is the review, and how big is it. The
 * row draws them as a mark, two chips and a size; these decide the words and
 * tones, so they can be tested without a renderer.
 *
 * The check rollup arrives on a SECOND pass — it costs about four times the
 * rest of the row — so a row that has not had it says "checks…" rather than
 * "no checks". Those are different claims and only one of them is true at that
 * moment.
 */
import type { PrSummary } from "../../../shared/types.ts";

export type Tone = "neutral" | "accent" | "good" | "warn" | "bad";
export type CiMark = "fail" | "run" | "ok" | "draft" | "none" | "loading";

export interface CiLook { mark: CiMark; label: string | null; tone: Tone }

export function ciLook(pr: PrSummary): CiLook {
  if (pr.isDraft) return { mark: "draft", label: null, tone: "neutral" };
  if (pr.checksLoaded === false) return { mark: "loading", label: "checks…", tone: "neutral" };
  const { total, failure, pending, verdict } = pr.checks ?? { total: 0, failure: 0, pending: 0, verdict: null };
  if (!total) return { mark: "none", label: null, tone: "neutral" };
  if (failure > 0) return { mark: "fail", label: `${failure} failed`, tone: "bad" };
  if (pending > 0) return { mark: "run", label: `${pending} running`, tone: "warn" };
  if (verdict === "green") return { mark: "ok", label: `${total} passed`, tone: "good" };
  return { mark: "none", label: null, tone: "neutral" };
}

/** Where the review is. Draft outranks everything — a draft is nobody's
 *  problem yet, and colouring it "review required" adds a queue entry that is
 *  not real. `forMe` is the Review filter, where every row is asking you, so
 *  "needs review" is said as the ask it is. */
export function reviewLook(pr: PrSummary, forMe: boolean): { label: string; tone: Tone } | null {
  if (pr.isDraft) return { label: "Draft", tone: "neutral" };
  const asked = forMe ? { label: "Needs your review", tone: "warn" as Tone } : { label: "Needs review", tone: "warn" as Tone };
  /* The verdict is the HUMANS', as on the desktop board. `reviewDecision`
   * counts a bot's approval, so a pull request one assistant had waved through
   * read "Approved" here beside a person's "changes requested". */
  const human = pr.humanReview;
  if (human && typeof human === "object" && human.kind) {
    if (human.kind === "changes") return { label: "Changes requested", tone: human.cleared ? "warn" : "bad" };
    if (human.kind === "approved") {
      /* Commits landed after it: GitHub's own decision says whether it still
       * counts, and is the only thing a list row can ask. */
      return human.stale && pr.reviewDecision !== "APPROVED"
        ? { label: "Approval out of date", tone: "warn" }
        : { label: "Approved", tone: "good" };
    }
    if (human.kind === "commented") return { label: "Commented", tone: "neutral" };
    return asked;
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { label: "Changes requested", tone: "bad" };
  /* No human verdict. Still being read (the second pass has not landed) is
   * silence; read and empty means nobody has looked, whatever a bot said. */
  if (pr.checksLoaded === false) return null;
  return pr.reviewDecision ? asked : null;
}

export interface RepoGroup<T> { root: string; name: string; items: T[] }

/** Rows of a list across repositories: a heading, then that repository's
 *  rows. Empty repositories are left out when more than one is shown — a
 *  heading over nothing is a line that says nothing — and kept when one is,
 *  so the screen can say "nothing open in orbit". */
export function flatten<T>(groups: RepoGroup<T>[]): ({ heading: string; count: number } | { item: T; root: string })[] {
  const shown = groups.length > 1 ? groups.filter((g) => g.items.length) : groups;
  return shown.flatMap((g) => [
    ...(groups.length > 1 ? [{ heading: g.name, count: g.items.length }] : []),
    ...g.items.map((item) => ({ item, root: g.root })),
  ]);
}
