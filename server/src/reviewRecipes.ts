/**
 * The prompts behind "Review with Claude", and the rule for which one is on top.
 *
 * There used to be two, chosen for you: "what is this pull request" for anything
 * you were not the author of, and "address the review" for your own with changes
 * requested. Both are still here — they are the two most common days — but they
 * were the whole menu, and a review is not one job. The one that forced this
 * out: a pull request reviewed once, changed, and handed back WITHOUT the
 * reviewer being re-requested, where the useful question is not "what is this"
 * but "what moved since I last looked, and did they do what I asked".
 *
 * Three things follow from that story and are worth stating, because they are
 * what makes this a catalogue rather than a longer if/else:
 *
 *  - GitHub's fields describe what somebody REMEMBERED to set. `viewerRequested`
 *    is false on a pull request you have reviewed three times if nobody
 *    re-requested you. So the fields pick what goes FIRST, and never what is
 *    available: every recipe is always in the menu.
 *  - The wording is data, not code. These are defaults; the ones the user has
 *    edited live in config and win (see `mergeRecipes`).
 *  - A recipe can be a skill instead of prose — `/pr-resolve-reviews 17598` —
 *    because a slash command IS the prompt for the flows that already have one.
 *
 * Placeholders are the things an agent cannot look up from inside a chat, and
 * `expandRecipe` is the only place that fills them in.
 */

import type { ReviewRecipe, ReviewRecipeContext, ReviewRecipeWhen } from "../../shared/types.ts";
export { suggestRecipeId, type ReviewSituation } from "../../shared/reviewSuggest.ts";

/**
 * What every prompt can say, and what each one means:
 *
 *   {number}  17598              the pull request
 *   {repo}    acme/shop          owner/name, as gh takes it
 *   {head}    a1b2c3d            the commit it is pinned to — a push mid-review
 *                                must not swap the code underneath the answer
 *   {branch}  fix/checkout-total the head branch
 *   {title}   …                  the pull request title
 *   {author}  someone            the login that opened it
 *   {url}     https://…          its page
 *   {since}   9f8e7d6            the commit YOUR last review was written
 *                                against, or empty when you have not reviewed it
 *   {card}    ORBIT-1042         the tracker id in the branch or title, if any
 *
 * An unknown placeholder is left exactly as typed: a prompt that says `{foo}`
 * meant to say it, and silently deleting a brace from somebody's careful
 * wording is worse than showing it.
 */
export function expandRecipe(body: string, ctx: ReviewRecipeContext): string {
  return body.replace(/\{(number|repo|head|branch|title|author|url|since|card)\}/g, (whole, key: string) => {
    const v = {
      number: String(ctx.number),
      repo: ctx.repo,
      head: ctx.head,
      branch: ctx.branch,
      title: ctx.title,
      author: ctx.author,
      url: ctx.url,
      since: ctx.since ?? "",
      card: ctx.card ?? "",
    }[key];
    return v === undefined ? whole : v;
  });
}

/** The line every read-only recipe opens with — one wording, so a change to it
 *  cannot reach nine prompts and miss the tenth. */
const READ_ONLY = "Read-only: change nothing, commit nothing, push nothing, and post nothing to GitHub. Answer here.";

/** Said in every prompt that reads the diff, because the obvious move otherwise
 *  is to read the working tree — the same project at a different commit, which
 *  is the surroundings and not the change. */
const NOT_THIS_CHECKOUT = "This checkout is the same project but not this pull request (it is at whatever you have checked out). Read the change from the commands above; use the working tree only for the surroundings.";

const PIN = "Pinned at {head}.";

function prompt(...lines: string[]): string {
  return lines.join("\n");
}

/**
 * The defaults.
 *
 * Order is the order of the menu inside each group, and `when` is only ever a
 * tiebreak for what sits at the top. `group` is what the menu draws as a
 * heading — "Reviewing", "Focused", "Your pull request".
 */
export const BUILT_IN_RECIPES: ReviewRecipe[] = [
  // -------------------------------------------------------------- reviewing
  {
    id: "understand",
    title: "What is this pull request?",
    group: "reviewing",
    when: "any",
    body: prompt(
      "Pull request #{number} of {repo}.",
      "",
      READ_ONLY,
      "",
      "  gh pr view {number}",
      "  gh pr diff {number}",
      "",
      NOT_THIS_CHECKOUT,
      "",
      "What is this pull request about?",
    ),
  },
  {
    id: "review-full",
    title: "Review it properly",
    group: "reviewing",
    when: "asked",
    body: prompt(
      "Pull request #{number} of {repo}, by {author}. My review is the one it is waiting on.",
      "",
      READ_ONLY,
      "",
      "  gh pr view {number}",
      "  gh pr diff {number}",
      "",
      NOT_THIS_CHECKOUT,
      "",
      "Review it. In this order, and stop at the first that has nothing to say rather than padding it:",
      "",
      "1. Correctness — what breaks, on which input, with which state. Not style.",
      "2. What the change forgot: a caller it did not update, an error path, a migration without a backfill, a flag left on.",
      "3. Tests — does a test actually fail without this change? Which case is missing?",
      "",
      "Then give me each finding as a comment I can paste, with `path:line` in front of it, ordered worst first. Say plainly if it is fine to approve.",
      PIN,
    ),
  },
  {
    id: "re-review",
    title: "What changed since my review",
    group: "reviewing",
    when: "reviewed",
    body: prompt(
      // Written to be true whether or not there is an earlier review: this is
      // the suggestion when there is one, and a menu entry anybody can pick
      // when there is not. "I have already reviewed this" was neither.
      "Pull request #{number} of {repo}. I want the part I have not read yet — what came after {since}.",
      "",
      READ_ONLY,
      "",
      "  gh pr view {number} --comments",
      "  gh api repos/{repo}/compare/{since}...{head}",
      "  gh pr diff {number}",
      "",
      NOT_THIS_CHECKOUT,
      // `compare` over a local `git diff` for the same reason the whole prompt
      // reads through gh: this checkout does not have the pull request's
      // commits unless somebody happened to fetch them, and a diff command that
      // fails with "bad revision" reads as the delta being empty.
      "`{since}` is the commit my last review was written against — or the base branch, if this is the first time I look at it.",
      "",
      "Two questions, in this order:",
      "",
      "1. What actually changed since {since}? Only that delta — I have read everything before it.",
      "2. Take each thing I asked for in my last review (my comments are in `gh pr view --comments`): was it done, done differently, argued with, or ignored? Quote the code that answers it. If I have never commented on this one, say so in one line and skip this question.",
      "",
      "Do not repeat findings that are already in a comment on this pull request — mine or anybody else's, bots included. New problems in the delta only. If the delta is clean and my points were addressed, say so in one line and stop.",
    ),
  },
  {
    id: "verdict",
    title: "Can I approve it? (quick)",
    group: "reviewing",
    when: "asked",
    body: prompt(
      "Pull request #{number} of {repo}, by {author}.",
      "",
      READ_ONLY,
      "",
      "  gh pr diff {number}",
      "  gh pr checks {number}",
      "",
      "Five lines, no more. Anything that BLOCKS an approval, and nothing else — no summary of what the change does, no nits, no praise. End with one word on its own line: APPROVE or WAIT.",
      PIN,
    ),
  },
  {
    id: "others-said",
    title: "What the other reviews already said",
    group: "reviewing",
    when: "reviewed",
    body: prompt(
      "Pull request #{number} of {repo}.",
      "",
      READ_ONLY,
      "",
      "  gh pr view {number} --comments",
      "  gh pr diff {number}",
      "",
      "Several people and at least one bot have reviewed this. I do not want to read it all again.",
      "",
      "1. Consolidate what has been said into the distinct points — one line each, merging the duplicates, with who raised it.",
      "2. Mark each one: resolved in the code, answered in words only, or still open.",
      "3. Then the part nobody covered: which files or behaviours in this diff has no review touched at all?",
      "",
      "That third answer is the one I am here for, so put the most effort there.",
    ),
  },
  {
    id: "card-check",
    title: "Does it do what the card asked?",
    group: "reviewing",
    when: "card",
    body: prompt(
      "Pull request #{number} of {repo}, for card {card}.",
      "",
      READ_ONLY,
      "",
      "  gh pr view {number}",
      "  gh pr diff {number}",
      "",
      "Read the card {card} (it is in this workspace) and the diff, then answer as a table: each acceptance criterion, and where in the diff it is met — `path:line` — or MISSING.",
      "",
      "Then two lines: what the pull request does that the card never asked for, and what the card asked for that nothing in the diff does.",
      PIN,
    ),
  },

  // ---------------------------------------------------------------- focused
  {
    id: "risk",
    title: "Risk and blast radius",
    group: "focused",
    when: "any",
    body: prompt(
      "Pull request #{number} of {repo}.",
      "",
      READ_ONLY,
      "",
      "  gh pr diff {number}",
      "",
      "Not a review — a risk read. What can this break in production that its own tests would not catch?",
      "",
      "Work outwards from the diff: every caller of a function whose behaviour changed (grep for it, do not assume), every consumer of a changed response shape, every flag or setting that now means something different. Say which of those you actually checked and which you could not.",
      "",
      "Then: if this goes out and is wrong, what is the first thing that looks wrong, and where would it show?",
    ),
  },
  {
    id: "tests",
    title: "Tests: what is missing",
    group: "focused",
    when: "any",
    body: prompt(
      "Pull request #{number} of {repo}.",
      "",
      READ_ONLY,
      "",
      "  gh pr diff {number}",
      "",
      "Only the tests. For each behaviour this diff changes, is there a test that FAILS without the change? Name it, or say there is none.",
      "",
      "Then the cases the diff opens and nothing covers — the boundary, the empty input, the second call, the concurrent one. Give each as the test I would write: the name, and the one assertion that matters.",
      "",
      "Ignore coverage as a number. A test that passes either way is worth nothing here.",
    ),
  },
  {
    id: "data",
    title: "Migrations and data safety",
    group: "focused",
    when: "any",
    body: prompt(
      "Pull request #{number} of {repo}.",
      "",
      READ_ONLY,
      "",
      "  gh pr diff {number}",
      "",
      "Only the data layer. For every migration, backfill or schema change in this diff:",
      "",
      "1. Is it safe on a table with production-sized rows — does it take a lock, rewrite the table, or block writes while it runs?",
      "2. Does the code deploy cleanly on both sides of it? Old code against the new schema, and new code against the old, in whichever order they will actually land.",
      "3. Is it reversible, and if not, say so plainly.",
      "4. Backfills: batched, resumable, and idempotent?",
      "",
      "If the diff has no migration, say that in one line and stop.",
    ),
  },
  {
    id: "security",
    title: "Security pass",
    group: "focused",
    when: "any",
    body: prompt(
      "Pull request #{number} of {repo}.",
      "",
      READ_ONLY,
      "",
      "  gh pr diff {number}",
      "",
      "Security only. Walk the change from the outside in: what new input reaches this code, from whom, and what does it get to touch?",
      "",
      "Check, and say which you checked rather than listing what you did not find: authentication and authorisation on every new path (including the object-level one — can user A ask for user B's row?), injection into whatever this talks to, secrets or personal data in logs and error bodies, a URL taken from a request and then fetched, file paths built from input, and anything raised from a permission this code did not have before.",
      "",
      "Rank what you find by what an attacker would actually do first.",
    ),
  },

  // ----------------------------------------------------------- your own one
  {
    id: "address",
    title: "Apply the review",
    group: "mine",
    when: "mine-changes",
    body: prompt(
      "Pull request #{number} of {repo}.",
      "",
      "This is your pull request and its review asked for changes — address them, don't just describe them.",
      "",
      "  gh pr checkout {number}",
      "  gh pr view {number}",
      "  gh pr diff {number}",
      "",
      "`gh pr checkout` puts you on the branch — make a worktree for the branch first if this checkout is holding work you don't want moved. `gh pr view` carries the reviewers' comments and every open thread. Work through each requested change: edit on the branch, keep the tests green (add one where a fix needs it), and commit. Don't push or post anything to GitHub unless I ask. " + PIN,
    ),
  },
  {
    id: "reply",
    title: "Draft my replies to the comments",
    group: "mine",
    when: "mine",
    body: prompt(
      "Pull request #{number} of {repo} — mine.",
      "",
      READ_ONLY + " In particular: do not edit the code, and do not post these replies. I will.",
      "",
      "  gh pr view {number} --comments",
      "  gh pr diff {number}",
      "",
      "For every open comment and thread, draft the reply I would send. One per thread, in the order they were written, each headed by `path:line — who`.",
      "",
      "Split them as you go: the ones where they are right and I should change the code (say what the change is, in a sentence), and the ones where the code is right and the reply has to make the case (then make it — quote the code that settles it, do not just assert).",
      "",
      "Short and plain. No thanking, no hedging, no 'good catch'.",
    ),
  },
  {
    id: "self-review",
    title: "Review it before I ask anyone",
    group: "mine",
    when: "mine",
    body: prompt(
      "Pull request #{number} of {repo} — mine, and nobody has reviewed it yet.",
      "",
      READ_ONLY,
      "",
      "  gh pr view {number}",
      "  gh pr diff {number}",
      "  gh pr checks {number}",
      "",
      "Review it as the harshest reviewer on the team would, and do not go easy because it is mine. Everything they would comment on, worst first, each with `path:line`.",
      "",
      "Then three checks I would rather hear from you than from them: does the description say what a reviewer needs to know (or does it describe the process instead of the change), is there anything in the diff that does not belong to it, and are the checks green.",
      PIN,
    ),
  },
  {
    id: "unblock",
    title: "What is blocking the merge?",
    group: "mine",
    when: "mine",
    body: prompt(
      "Pull request #{number} of {repo} — mine, and it is not merging.",
      "",
      READ_ONLY + " Diagnose it; do not fix anything yet.",
      "",
      "  gh pr view {number}",
      "  gh pr checks {number}",
      "  gh pr view {number} --json mergeable,mergeStateStatus,reviewDecision",
      "",
      "Tell me what is actually in the way, in the order I have to deal with it: failing checks (which test, which line of the log — read it, do not guess from the name), conflicts with the base, reviews still owed and by whom, anything else GitHub is holding it on.",
      "",
      "For each one, the next command I run. If it is only waiting on people, say that and name them.",
    ),
  },
];

/** Kept for the shape of the catalogue: which situation a recipe is written
 *  for, used by Settings to explain itself. */
export function whenOf(id: string): ReviewRecipeWhen {
  return BUILT_IN_RECIPES.find((r) => r.id === id)?.when ?? "any";
}
