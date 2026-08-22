/*
 * The menu behind "hand this to Claude".
 *
 * The catalogue is FETCHED from `/pr-prompts` — the merged list, built-ins
 * plus whatever the user edited — so there is no copy here to drift. What is
 * left to get wrong is the two rules the phone applies on top of it, and both
 * of them fail quietly:
 *
 *   offering a recipe that edits a branch on somebody else's pull request,
 *   which is not a worse choice but a thing that cannot happen;
 *
 *   treating the suggestion as a filter, which hides the right answer in the
 *   exact case the feature was written for.
 *
 * The catalogue used in these tests is the SERVER's own, parsed off disk. It
 * is what the phone will really be handed, so a group renamed there — which
 * would silently empty one side of the menu — fails here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { menuFor, situationOf } from "../src/model/reviewMenu.ts";
import type { ReviewRecipe } from "../../shared/types.ts";

/**
 * The built-in catalogue, read from the file that defines it.
 *
 * A parse rather than an import: server/src/reviewRecipes.ts pulls in the
 * server's module graph, and this wants the four fields the menu turns on.
 */
function catalogue(): ReviewRecipe[] {
  const path = join(import.meta.dir, "..", "..", "server", "src", "reviewRecipes.ts");
  const source = readFileSync(path, "utf8");
  const out: ReviewRecipe[] = [];
  const re = /^\s{4}id:\s*"([a-z-]+)",\n\s{4}title:\s*"([^"]+)",\n\s{4}group:\s*"([a-z]+)",\n\s{4}when:\s*"([a-z-]+)"/gm;
  for (const m of source.matchAll(re)) {
    out.push({
      id: m[1]!, title: m[2]!, body: "", group: m[3] as never, when: m[4] as never, builtIn: true,
    });
  }
  return out;
}

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

const menu = (over: Partial<Parameters<typeof situationOf>[0]> = {}, list = catalogue()) =>
  menuFor(situationOf(pr(over)), list);

describe("the catalogue this is tested against", () => {
  test("the server's file was actually parsed", () => {
    // A regex that stops matching makes every assertion below vacuous.
    const all = catalogue();
    expect(all.length).toBeGreaterThanOrEqual(10);
    expect(all.map((r) => r.id)).toContain("understand");
    expect(all.map((r) => r.id)).toContain("address");
  });

  test("both sides of the menu have something in them", () => {
    // The failure this catches: a group renamed on the server, which would
    // empty one side of the phone's menu with no error anywhere.
    const all = catalogue();
    expect(all.filter((r) => r.group === "mine").length).toBeGreaterThan(0);
    expect(all.filter((r) => r.group === "reviewing").length).toBeGreaterThan(0);
  });
});

describe("what is offered", () => {
  test("somebody else's pull request is never offered a recipe that edits it", () => {
    const ids = menu().recipes.map((r) => r.id);
    expect(ids).not.toContain("address");
    expect(ids).not.toContain("self-review");
    expect(ids).not.toContain("unblock");
  });

  test("your own is never offered the outsider's reading of it", () => {
    const ids = menu({ viewerDidAuthor: true }).recipes.map((r) => r.id);
    expect(ids).not.toContain("understand");
    expect(ids).not.toContain("review-full");
  });

  test("the ones that write to GitHub are left at the desk", () => {
    // `telling` asks somebody for a review, in chat. A phone posting on your
    // behalf from a sheet with no preview is not something to offer.
    const all = [...menu().recipes, ...menu({ viewerDidAuthor: true }).recipes];
    expect(all.every((r) => r.group !== "telling")).toBe(true);
  });

  test("a recipe switched off at the desk does not appear", () => {
    const hidden = catalogue().map((r) => (r.id === "understand" ? { ...r, hidden: true } : r));
    expect(menu({}, hidden).recipes.map((r) => r.id)).not.toContain("understand");
  });

  test("one the user wrote themselves is offered like any other", () => {
    // The whole reason the catalogue is fetched rather than copied.
    const mine: ReviewRecipe = {
      id: "house-style", title: "Check it against our house style", body: "",
      group: "reviewing", when: "any",
    };
    const ids = menu({}, [...catalogue(), mine]).recipes.map((r) => r.id);
    expect(ids).toContain("house-style");
  });
});

describe("the order", () => {
  test("the suggestion is first and everything else is still there", () => {
    const { recipes, suggested } = menu({ viewerRequested: true });
    expect(suggested).toBe("review-full");
    expect(recipes[0]?.id).toBe("review-full");
    // Never a filter: the case this feature exists for is a pull request
    // handed back a third time without the reviewer being re-requested.
    expect(recipes.map((r) => r.id)).toContain("understand");
    expect(recipes.map((r) => r.id)).toContain("re-review");
  });

  test("changes requested on mine leads with applying them", () => {
    const { recipes, suggested } = menu({
      viewerDidAuthor: true,
      reviewDecision: "CHANGES_REQUESTED",
      reviews: [{ viewerDidAuthor: false, state: "CHANGES_REQUESTED" }],
    });
    expect(suggested).toBe("address");
    expect(recipes[0]?.id).toBe("address");
  });

  test("a red check on mine leads with what is blocking the merge", () => {
    expect(menu({
      viewerDidAuthor: true,
      checks: { failure: 2 },
      reviews: [{ viewerDidAuthor: false, state: "COMMENTED" }],
    }).suggested).toBe("unblock");
  });

  test("a conflict counts as blocked, the same as a red check", () => {
    expect(menu({
      viewerDidAuthor: true,
      mergeable: "CONFLICTING",
      reviews: [{ viewerDidAuthor: false, state: "COMMENTED" }],
    }).suggested).toBe("unblock");
  });

  test("nobody has read mine yet, so the offer is to read it myself", () => {
    expect(menu({ viewerDidAuthor: true }).suggested).toBe("self-review");
  });

  test("rank wins over the catalogue's own position", () => {
    const ranked = catalogue().map((r) => (r.id === "verdict" ? { ...r, rank: -1 } : r));
    const ids = menu({}, ranked).recipes.map((r) => r.id);
    // "understand" is the suggestion here and takes the top slot; `verdict`
    // is then the first of the rest.
    expect(ids[0]).toBe("understand");
    expect(ids[1]).toBe("verdict");
  });

  test("with no ranks at all the server's order survives", () => {
    // An unstable comparison would reverse it, and the two products would then
    // list the same menu differently.
    const all = catalogue();
    const ids = menu({ viewerDidAuthor: true }, all).recipes.map((r) => r.id);
    const expected = all
      .filter((r) => r.group === "mine")
      .map((r) => r.id)
      .filter((id) => id !== "self-review");
    expect(ids.slice(1)).toEqual(expected);
  });
});

describe("moved since my review", () => {
  test("it needs a review of MINE, not just a force-push", () => {
    const pushed = situationOf(pr({ forcePushedSinceReview: true }));
    expect(pushed.movedSinceMyReview).toBe(false);
    expect(menu({ forcePushedSinceReview: true }).suggested).toBe("understand");
  });

  test("somebody else's review does not make it mine", () => {
    expect(situationOf(pr({
      forcePushedSinceReview: true,
      reviews: [{ viewerDidAuthor: false, state: "APPROVED" }],
    })).movedSinceMyReview).toBe(false);
  });

  test("my review plus a force-push is what leads with re-review", () => {
    expect(menu({
      forcePushedSinceReview: true,
      reviews: [{ viewerDidAuthor: true, state: "CHANGES_REQUESTED" }],
    }).suggested).toBe("re-review");
  });

  test("a pending review of mine is a draft nobody has submitted", () => {
    expect(situationOf(pr({
      forcePushedSinceReview: true,
      reviews: [{ viewerDidAuthor: true, state: "PENDING" }],
    })).movedSinceMyReview).toBe(false);
  });

  test("an absent viewerDidAuthor is 'not mine', never 'unknown'", () => {
    // It is optional on the wire. Treating a missing field as mine would put
    // "what changed since my review" on a pull request you never opened.
    expect(situationOf(pr({
      forcePushedSinceReview: true,
      reviews: [{ state: "APPROVED" }],
    })).movedSinceMyReview).toBe(false);
  });
});
