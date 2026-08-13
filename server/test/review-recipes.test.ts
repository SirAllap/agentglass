import { afterAll, beforeEach, describe, expect, it } from "bun:test";

/*
 * The catalogue, and what an edit does to it.
 *
 * The shape being pinned here is the one that makes editing safe: a built-in
 * the user reworded keeps its ID, so the app can still tell it apart from a
 * copy, put it back, and hand the next improvement to everyone who did NOT
 * reword it. A design where "edit" meant "duplicate into your file" would pass
 * a shallower version of every test below and freeze the catalogue on the day
 * somebody first touched it.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "agx-review-prompts-"));
const FILE = join(TMP, "review-prompts.json");

const P = await import("../src/reviewPrompts.ts");
const C = await import("../src/reviewRecipes.ts");

beforeEach(() => { P.__setReviewPromptsPath(FILE); try { rmSync(FILE, { force: true }); } catch { /* fine */ } P.__clearReviewPrompts(); P.__setReviewPromptsPath(FILE); });
afterAll(() => { P.__setReviewPromptsPath(null); try { rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

const ctx = {
  number: 17, repo: "acme/shop", head: "abc1234", branch: "fix/checkout-total",
  title: "Fix the total", author: "someone", url: "https://github.com/acme/shop/pull/17",
  since: "9f8e7d6", card: "ORBIT-1042",
};

describe("the placeholders", () => {
  it("fill in from the pull request", () => {
    const out = C.expandRecipe("#{number} of {repo} at {head}, {branch}, by {author} — {card}", ctx);
    expect(out).toBe("#17 of acme/shop at abc1234, fix/checkout-total, by someone — ORBIT-1042");
  });

  it("leave a name they do not know exactly as it was typed", () => {
    // Silently deleting a brace from somebody's careful wording is worse than
    // showing it: the prompt is the product here.
    expect(C.expandRecipe("{nope} and {number}", ctx)).toBe("{nope} and 17");
  });

  it("become empty, not the word undefined, when there is nothing to say", () => {
    expect(C.expandRecipe("since {since}", { ...ctx, since: null })).toBe("since ");
  });
});

describe("which prompt is suggested", () => {
  const s = (over: Partial<Parameters<typeof C.suggestRecipeId>[0]>) => C.suggestRecipeId({
    viewerDidAuthor: false, reviewDecision: null, viewerRequested: false, movedSinceMyReview: false, ...over,
  });

  it("puts your own pull request first, in the order the work happens", () => {
    expect(s({ viewerDidAuthor: true, reviewDecision: "CHANGES_REQUESTED" })).toBe("address");
    expect(s({ viewerDidAuthor: true, blocked: true })).toBe("unblock");
    expect(s({ viewerDidAuthor: true, reviewsSoFar: 0 })).toBe("self-review");
    expect(s({ viewerDidAuthor: true, reviewsSoFar: 3 })).toBe("reply");
  });

  /* The case the feature exists for. Nobody re-requested the review, so the
     field GitHub offers is false and describes the wrong job. */
  it("prefers 'what changed' over 'review it' when you have already reviewed it", () => {
    expect(s({ movedSinceMyReview: true, viewerRequested: true })).toBe("re-review");
    expect(s({ movedSinceMyReview: true, viewerRequested: false })).toBe("re-review");
  });

  it("falls back to understanding it", () => {
    expect(s({ viewerRequested: true })).toBe("review-full");
    expect(s({})).toBe("understand");
  });
});

describe("the menu", () => {
  it("is the catalogue when nothing has been edited", () => {
    const list = P.reviewRecipes();
    expect(list.length).toBe(C.BUILT_IN_RECIPES.length);
    expect(list.every((r) => r.builtIn)).toBe(true);
    // Grouped, and in the catalogue's order inside each group.
    expect(list.map((r) => r.group)).toEqual([...list.map((r) => r.group)].sort((a, b) =>
      ["reviewing", "focused", "mine"].indexOf(a) - ["reviewing", "focused", "mine"].indexOf(b)));
  });

  it("keeps an edited built-in a built-in, under the same id", () => {
    const before = P.reviewRecipe("verdict")!;
    P.saveReviewRecipe({ ...before, title: "Ship it?" });
    const after = P.reviewRecipe("verdict")!;
    expect(after.title).toBe("Ship it?");
    expect(after.builtIn).toBe(true);
    expect(P.reviewRecipes().filter((r) => r.id === "verdict").length).toBe(1);
    // And only the fields that were edited moved: the body is still the one it
    // ships with, so a later improvement to the wording is not lost to a title
    // change made a month ago.
    expect(after.body).toBe(before.body);
  });

  it("puts a deleted built-in back when it is reset", () => {
    P.removeReviewRecipe("verdict");
    expect(P.reviewRecipe("verdict")).toBeNull();
    // A tombstone, or the catalogue would hand it straight back on the next start.
    expect(readFileSync(FILE, "utf8")).toContain('"hidden": true');
    P.resetReviewRecipe("verdict");
    expect(P.reviewRecipe("verdict")?.title).toBe("Can I approve it? (quick)");
  });

  it("takes one of your own, and gives it back to you to delete", () => {
    const saved = P.saveReviewRecipe({ id: "", title: "Only the migrations", body: "Look at {number}", group: "focused", when: "any" });
    expect(saved.ok).toBe(true);
    const id = saved.recipe!.id;
    expect(P.reviewRecipe(id)?.builtIn).toBe(false);
    P.removeReviewRecipe(id);
    expect(P.reviewRecipe(id)).toBeNull();
    // Deleted, not hidden: there is no catalogue entry to keep it out of.
    expect(existsSync(FILE) ? readFileSync(FILE, "utf8") : "").not.toContain(id);
  });

  it("refuses the ones that would render as an empty menu row", () => {
    expect(P.saveReviewRecipe({ id: "", title: "  ", body: "x", group: "focused", when: "any" }).ok).toBe(false);
    expect(P.saveReviewRecipe({ id: "", title: "No body", body: "  ", group: "focused", when: "any" }).ok).toBe(false);
    // …but a skill IS a prompt, so a body is only required when there is no skill.
    expect(P.saveReviewRecipe({ id: "", title: "Resolve", body: "", skill: "/pr-resolve-reviews {number}", group: "mine", when: "mine" }).ok).toBe(true);
    expect(P.saveReviewRecipe({ id: "", title: "Bad skill", body: "", skill: "pr-resolve-reviews", group: "mine", when: "mine" }).ok).toBe(false);
  });
});

describe("the text that reaches the agent", () => {
  const situation = { viewerDidAuthor: false, reviewDecision: null, viewerRequested: false, movedSinceMyReview: false };

  it("is the one asked for by id", () => {
    const out = P.recipePromptText({ id: "security", pr: ctx, situation });
    expect(out).toContain("Security only");
    expect(out).toContain("#17 of acme/shop");
  });

  /* A prompt can be deleted in Settings between the menu being drawn and the
     button being pressed. The honest answer to that is the read-only opener,
     not an error where a chat should be. */
  it("falls back to the situation's own when that id is gone", () => {
    P.removeReviewRecipe("security");
    expect(P.recipePromptText({ id: "security", pr: ctx, situation })).toContain("What is this pull request about");
  });

  it("puts a skill on the first line, with the body after it", () => {
    P.saveReviewRecipe({ id: "resolve", title: "Resolve the reviews", body: "Stay on the branch.", skill: "/pr-resolve-reviews {number} interactive", group: "mine", when: "mine" });
    const out = P.recipePromptText({ id: "resolve", pr: ctx, situation });
    expect(out.split("\n")[0]).toBe("/pr-resolve-reviews 17 interactive");
    expect(out).toContain("Stay on the branch.");
  });
});
