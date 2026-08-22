/*
 * What "hand this to Claude" offers, and which entry is on top.
 *
 * ── the ids are the contract, and the text is not ─────────────────────────
 * The socket carries an ID and never a prompt. `cmd: "review"` takes a number,
 * a directory and a recipe id; the server looks the id up in its own catalogue
 * (server/src/reviewRecipes.ts) and builds the text there. That is a security
 * property rather than a tidiness one — a socket reachable from the UI must not
 * be a way to choose what an agent is told — and it is why this file can carry
 * titles without carrying prompts.
 *
 * It also means an id this app does not recognise is harmless in both
 * directions. The server falls back to the recipe the pull request calls for
 * when it is handed one it has never heard of, so the worst a stale entry here
 * can do is offer a name that quietly resolves to the sensible default.
 *
 * ── why the titles are copied rather than fetched ─────────────────────────
 * There is no route that lists them. The desktop reads the catalogue in
 * process, which a phone cannot, and adding a route to serve fifteen strings
 * that change about once a year is a route to keep in step for nothing.
 *
 * The copy is the risk that buys, and it is bounded: a title that has drifted
 * shows the wrong WORDS for the right prompt, which is a cosmetic bug on a
 * sheet, not a wrong prompt. `test/review-menu.test.ts` reads the server's
 * catalogue off disk and fails when an id here has no counterpart there, so
 * the half that matters — the ids — cannot drift silently.
 *
 * ── why not all fifteen ───────────────────────────────────────────────────
 * The desktop's menu has fifteen entries in four groups behind a `▾`. A phone
 * sheet is a list you scroll with a thumb, and fifteen of anything is a list
 * nobody reads to the bottom of. These are the ones that answer a question you
 * would ask standing up; the focused four (risk, tests, data, security) and the
 * two that write to GitHub are deliberately left at the desk.
 */
export { suggestRecipeId, type ReviewSituation } from "../../../shared/reviewSuggest.ts";
import { suggestRecipeId, type ReviewSituation } from "../../../shared/reviewSuggest.ts";

export interface Recipe {
  /** The id the socket carries. Must exist in the server's catalogue. */
  id: string;
  /** What the sheet calls it. The server's own title, copied. */
  title: string;
  /** One line under it, written for a phone: what you get, not how it works. */
  sub: string;
  /** Offered on a pull request you opened, on somebody else's, or on both.
   *  GitHub will not let you review your own work and neither should this. */
  when: "mine" | "theirs" | "any";
}

export const RECIPES: Recipe[] = [
  // ── somebody else's ─────────────────────────────────────────────────────
  { id: "understand", title: "What is this pull request?", sub: "Reads it and explains it. Changes nothing.", when: "theirs" },
  { id: "review-full", title: "Review it properly", sub: "Goes through the diff and gives an opinion.", when: "theirs" },
  { id: "re-review", title: "What changed since my review", sub: "Only the part you have not seen.", when: "theirs" },
  { id: "verdict", title: "Can I approve it?", sub: "The short answer, for when you are deciding.", when: "theirs" },
  { id: "others-said", title: "What the other reviews said", sub: "Catches you up on the conversation.", when: "theirs" },

  // ── yours ───────────────────────────────────────────────────────────────
  { id: "address", title: "Apply the review", sub: "Does what the comments asked for.", when: "mine" },
  { id: "reply", title: "Draft my replies", sub: "Writes answers to the comments, unsent.", when: "mine" },
  { id: "self-review", title: "Review it before I ask anyone", sub: "A pass over your own work.", when: "mine" },
  { id: "unblock", title: "What is blocking the merge?", sub: "Failing checks, conflicts, missing reviews.", when: "mine" },
];

/**
 * The menu for one pull request, suggestion first.
 *
 * Sorted rather than filtered down to one: `suggestRecipeId` is explicit that
 * it is "a suggestion and never a filter", because the field it leans on —
 * `viewerRequested` — describes what somebody remembered to tick. The whole
 * feature exists for a pull request handed back a third time without the
 * reviewer being re-requested, where the suggestion is wrong and the menu has
 * to still contain the right answer.
 *
 * `mine`/`theirs` IS a filter, and a different kind: a recipe that applies a
 * review to somebody else's branch is not a worse choice, it is a thing that
 * cannot happen.
 */
export function menuFor(pr: ReviewSituation): { recipes: Recipe[]; suggested: string } {
  const suggested = suggestRecipeId(pr);
  const side = pr.viewerDidAuthor ? "mine" : "theirs";
  const usable = RECIPES.filter((r) => r.when === "any" || r.when === side);
  // Stable otherwise: the order above is the order the desk lists them in, and
  // a sheet that reshuffles between openings is one you have to read twice.
  const top = usable.filter((r) => r.id === suggested);
  const rest = usable.filter((r) => r.id !== suggested);
  return { recipes: [...top, ...rest], suggested };
}

/**
 * What this app knows about a pull request, from the detail it already has.
 *
 * Its own function so the two callers — the sheet and its test — build the
 * situation the same way. `movedSinceMyReview` is the one that cannot be read
 * off a single field: it is whether a review of MINE exists and the head has
 * moved since, which is what `forcePushedSinceReview` reports.
 */
export function situationOf(pr: {
  viewerDidAuthor: boolean;
  reviewDecision: string | null;
  viewerRequested: boolean;
  forcePushedSinceReview: boolean;
  /** `viewerDidAuthor` is optional on the wire — GitHub omits it on reviews it
   *  will not attribute — and an absent one is "not mine", never "unknown".
   *  Typed loosely here so `PrDetail` fits without a cast. */
  reviews: { viewerDidAuthor?: boolean; state: string }[];
  checks: { failure: number };
  mergeable: string;
}): ReviewSituation {
  const mine = pr.reviews.filter((r) => r.viewerDidAuthor && r.state !== "PENDING");
  return {
    viewerDidAuthor: pr.viewerDidAuthor,
    reviewDecision: pr.reviewDecision,
    viewerRequested: pr.viewerRequested,
    movedSinceMyReview: mine.length > 0 && pr.forcePushedSinceReview,
    reviewsSoFar: pr.reviews.length,
    // "Blocked" here is the merge being held up, which is what the `unblock`
    // recipe is about — a red check or a conflict, not a missing approval.
    blocked: pr.checks.failure > 0 || pr.mergeable === "CONFLICTING",
  };
}
