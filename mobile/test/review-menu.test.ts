/*
 * The menu behind "hand this to Claude", and the one thing about it that can
 * break silently.
 *
 * The socket carries a recipe ID and never a prompt — the server looks the id
 * up in its own catalogue and writes the text. That is what makes this safe and
 * it is also what makes it fragile in exactly one way: an id that no longer
 * exists on the server produces no error anywhere. `prepareReviewPrompt` falls
 * back to the recipe the pull request calls for, so the window opens, the agent
 * runs, and the only symptom is that it answered a different question from the
 * one on the button.
 *
 * So the first test reads the SERVER's catalogue off disk. It is the one check
 * here that could not be written any other way, and the one that pays for the
 * duplicated titles.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RECIPES, menuFor, situationOf } from "../src/model/reviewMenu.ts";

/** Every id the server defines, read from the file that defines them. A parse
 *  rather than an import: server/src/reviewRecipes.ts pulls in the server's own
 *  module graph, and this test wants one list of strings. */
function serverIds(): string[] {
  const path = join(import.meta.dir, "..", "..", "server", "src", "reviewRecipes.ts");
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/^\s{4}id:\s*"([a-z-]+)"/gm)].map((m) => m[1]!);
}

/** A pull request, with only the fields the menu reads. */
const pr = (over: Partial<Parameters<typeof situationOf>[0]> = {}) => ({
  viewerDidAuthor: false,
  reviewDecision: null,
  viewerRequested: false,
  forcePushedSinceReview: false,
  reviews: [] as { viewerDidAuthor?: boolean; state: string }[],
  checks: { failure: 0 },
  mergeable: "MERGEABLE",
  ...over,
});

describe("the ids the phone offers", () => {
  test("the server's catalogue was actually read", () => {
    // A regex that stops matching would make every assertion below vacuous.
    const ids = serverIds();
    expect(ids.length).toBeGreaterThanOrEqual(10);
    expect(ids).toContain("understand");
  });

  test("every one of them exists on the server", () => {
    const ids = new Set(serverIds());
    const orphans = RECIPES.filter((r) => !ids.has(r.id)).map((r) => r.id);
    expect(
      orphans,
      "these ids are offered by the phone and no longer exist in the server's "
      + "catalogue. The server would silently fall back to a different prompt.",
    ).toEqual([]);
  });

  test("no id is offered twice", () => {
    const seen = RECIPES.map((r) => r.id);
    expect(seen).toEqual([...new Set(seen)]);
  });

  test("every entry says what it does", () => {
    // The sub-line is the only thing separating "Review it properly" from
    // "Review it before I ask anyone" on a small screen.
    for (const recipe of RECIPES) {
      expect(recipe.title.length, `${recipe.id} has no title`).toBeGreaterThan(3);
      expect(recipe.sub.length, `${recipe.id} has no sub`).toBeGreaterThan(10);
    }
  });
});

describe("what the sheet offers, and in what order", () => {
  test("a pull request of somebody else's never offers to apply the review", () => {
    // "address" edits the branch. On a pull request you did not open, that is
    // not a worse choice than the others — it is a thing that must not happen.
    const { recipes } = menuFor(situationOf(pr()));
    expect(recipes.map((r) => r.id)).not.toContain("address");
    expect(recipes.map((r) => r.id)).not.toContain("self-review");
  });

  test("your own pull request never offers to review it as an outsider", () => {
    const { recipes } = menuFor(situationOf(pr({ viewerDidAuthor: true })));
    expect(recipes.map((r) => r.id)).not.toContain("review-full");
    expect(recipes.map((r) => r.id)).not.toContain("understand");
  });

  test("the suggestion is first, and the rest are all still there", () => {
    // The whole argument in shared/reviewSuggest.ts is that this is a
    // suggestion and never a filter — the case it was written for is a pull
    // request handed back without the reviewer being re-requested, where the
    // suggested one is wrong and the right one has to still be reachable.
    const situation = situationOf(pr({ viewerRequested: true }));
    const { recipes, suggested } = menuFor(situation);
    expect(suggested).toBe("review-full");
    expect(recipes[0]?.id).toBe("review-full");
    expect(recipes.map((r) => r.id)).toContain("understand");
    expect(recipes.map((r) => r.id)).toContain("re-review");
  });

  test("changes requested on mine leads with applying them", () => {
    const { recipes, suggested } = menuFor(situationOf(pr({
      viewerDidAuthor: true,
      reviewDecision: "CHANGES_REQUESTED",
      reviews: [{ viewerDidAuthor: false, state: "CHANGES_REQUESTED" }],
    })));
    expect(suggested).toBe("address");
    expect(recipes[0]?.id).toBe("address");
  });

  test("a red check on mine leads with what is blocking the merge", () => {
    const { suggested } = menuFor(situationOf(pr({
      viewerDidAuthor: true,
      checks: { failure: 2 },
      reviews: [{ viewerDidAuthor: false, state: "COMMENTED" }],
    })));
    expect(suggested).toBe("unblock");
  });

  test("a conflict counts as blocked, the same as a red check", () => {
    // `mergeable` is on the summary precisely because a conflict is a
    // different need from a failing check — but for "what is stopping this
    // merging", they are the same question.
    const { suggested } = menuFor(situationOf(pr({
      viewerDidAuthor: true,
      mergeable: "CONFLICTING",
      reviews: [{ viewerDidAuthor: false, state: "COMMENTED" }],
    })));
    expect(suggested).toBe("unblock");
  });

  test("nobody has read mine yet, so the offer is to read it myself", () => {
    const { suggested } = menuFor(situationOf(pr({ viewerDidAuthor: true })));
    expect(suggested).toBe("self-review");
  });
});

describe("moved since my review", () => {
  test("it needs a review of MINE, not just a force-push", () => {
    // A force-push on a pull request nobody has reviewed is not "changed since
    // I looked" — there is no since.
    const pushedNobodyRead = situationOf(pr({ forcePushedSinceReview: true }));
    expect(pushedNobodyRead.movedSinceMyReview).toBe(false);
    expect(menuFor(pushedNobodyRead).suggested).toBe("understand");
  });

  test("somebody else's review does not make it mine", () => {
    const theirs = situationOf(pr({
      forcePushedSinceReview: true,
      reviews: [{ viewerDidAuthor: false, state: "APPROVED" }],
    }));
    expect(theirs.movedSinceMyReview).toBe(false);
  });

  test("my review plus a force-push is what leads with re-review", () => {
    const mine = situationOf(pr({
      forcePushedSinceReview: true,
      reviews: [{ viewerDidAuthor: true, state: "CHANGES_REQUESTED" }],
    }));
    expect(mine.movedSinceMyReview).toBe(true);
    expect(menuFor(mine).suggested).toBe("re-review");
  });

  test("a pending review of mine is not a review yet", () => {
    // PENDING is a draft nobody has submitted. Counting it would tell you what
    // changed since a review the author has never seen.
    const draft = situationOf(pr({
      forcePushedSinceReview: true,
      reviews: [{ viewerDidAuthor: true, state: "PENDING" }],
    }));
    expect(draft.movedSinceMyReview).toBe(false);
  });

  test("an absent viewerDidAuthor is 'not mine', never 'unknown'", () => {
    // It is optional on the wire — GitHub omits it on reviews it will not
    // attribute — and treating a missing field as mine would put "what changed
    // since my review" on top of a pull request you have never opened.
    const absent = situationOf(pr({
      forcePushedSinceReview: true,
      reviews: [{ state: "APPROVED" }],
    }));
    expect(absent.movedSinceMyReview).toBe(false);
  });
});
