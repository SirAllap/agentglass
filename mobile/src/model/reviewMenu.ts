/*
 * What "hand this to Claude" offers, and which entry is on top.
 *
 * ── the catalogue is fetched, not copied ─────────────────────────────────
 * `/pr-prompts` answers with the whole menu — `ReviewRecipe[]`, a shared wire
 * type — and it is the MERGED list: the built-ins with the user's own edits
 * and additions on top of them. So the phone offers exactly what the desktop
 * offers, including a recipe somebody wrote yesterday, and a title cannot
 * drift because there is only one of it.
 *
 * This file used to carry a copy of the titles, on the belief that no route
 * listed them. That was wrong, and the copy would have been wrong twice over:
 * stale wording is the small half, and the big half is that a hand-edited
 * catalogue would never have reached the phone at all.
 *
 * ── the ids are still the contract ───────────────────────────────────────
 * The socket carries an id and never a prompt. `cmd: "review"` takes a number,
 * a directory and a recipe id; the server looks the id up and builds the text
 * there. A socket reachable from the UI must not be a way to choose what an
 * agent is told, which is why this module deals in ids and ordering and never
 * in bodies — `ReviewRecipe.body` arrives here and is deliberately not shown.
 *
 * ── what this file is actually for ───────────────────────────────────────
 * Two rules the server does not apply, because the desktop applies them in its
 * own menu component and a phone needs them somewhere testable:
 *
 *   which recipes are POSSIBLE on this pull request — a filter, and the only
 *   hard one: "apply the review" edits a branch, so it cannot be offered on
 *   somebody else's.
 *
 *   which is SUGGESTED — never a filter. `suggestRecipeId` lives in shared/
 *   and its own header explains why it is only ever a tiebreak.
 */
import type { ReviewRecipe } from "../../../shared/types.ts";
export { suggestRecipeId, type ReviewSituation } from "../../../shared/reviewSuggest.ts";
import { suggestRecipeId, type ReviewSituation } from "../../../shared/reviewSuggest.ts";

/** The route, named once. A GET, so a phone paired for `read` can draw the
 *  menu — which matters, because reviewing is a read and the hand-off writes
 *  nothing to GitHub. */
export const RECIPES_PATH = "/pr-prompts";

/**
 * Which side of a pull request a group belongs to.
 *
 * The server's four groups are `reviewing`, `focused`, `mine` and `telling`.
 * Only `mine` is about work you opened; `telling` writes to GitHub (it asks
 * somebody for a review, in chat) and is left at the desk — a phone that
 * posted on your behalf from a sheet with no preview is not a thing this app
 * should offer.
 */
function sideOf(recipe: ReviewRecipe): "mine" | "theirs" | null {
  if (recipe.group === "mine") return "mine";
  if (recipe.group === "reviewing" || recipe.group === "focused") return "theirs";
  return null;
}

/**
 * The menu for one pull request, suggestion first.
 *
 * Hidden recipes are dropped — that flag is somebody switching one off at the
 * desk, and a phone that ignored it would be a second place the menu is
 * decided. Order inside a group is the catalogue's own `order` when it has
 * one, and its position otherwise, so the two products list them the same way.
 */
export function menuFor(pr: ReviewSituation, catalogue: ReviewRecipe[]): {
  recipes: ReviewRecipe[];
  suggested: string;
} {
  const suggested = suggestRecipeId(pr);
  const side = pr.viewerDidAuthor ? "mine" : "theirs";

  const usable = catalogue
    .map((recipe, at) => ({ recipe, at }))
    .filter(({ recipe }) => !recipe.hidden && sideOf(recipe) === side)
    .sort((a, b) => {
      const ao = a.recipe.rank ?? Number.MAX_SAFE_INTEGER;
      const bo = b.recipe.rank ?? Number.MAX_SAFE_INTEGER;
      // Falls back to the catalogue's own order, so a list with no `order` set
      // anywhere comes out exactly as the server sent it rather than reversed
      // by an unstable comparison.
      return ao - bo || a.at - b.at;
    })
    .map(({ recipe }) => recipe);

  // Sorted, not filtered: the situation the whole feature exists for is a pull
  // request handed back a third time without the reviewer being re-requested,
  // where the suggestion is wrong and the right answer must still be reachable.
  const top = usable.filter((r) => r.id === suggested);
  const rest = usable.filter((r) => r.id !== suggested);
  return { recipes: [...top, ...rest], suggested };
}

/**
 * What this app knows about a pull request, from the detail it already has.
 *
 * Its own function so the sheet and its tests build the situation the same
 * way. `movedSinceMyReview` is the one that cannot be read off a single field:
 * it is whether a review of MINE exists and the head has moved since.
 */
export function situationOf(pr: {
  viewerDidAuthor: boolean;
  reviewDecision: string | null;
  viewerRequested: boolean;
  forcePushedSinceReview: boolean;
  /** `viewerDidAuthor` is optional on the wire — GitHub omits it on reviews it
   *  will not attribute — and an absent one is "not mine", never "unknown". */
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
