// Who was asked to review, in one shape.
//
// The list learned that a reviewer can be a team — a team has no login and no
// avatar, so drawing one as a portrait fetches a broken image — and was given
// an object that could say so. The detail view kept the older bare `string[]`,
// which made `PrDetail extends PrSummary` a compile error, and long before
// anyone read that error it meant the detail sidebar was asking the avatar
// proxy for a picture of "platform".
//
// Two mappers is how they drifted, so what is pinned here is the one mapper and
// the cases the hand-rolled copy got wrong.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-reviewers-"));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "r.db");

const prs = await import("../src/prs.ts");
const src = readFileSync(new URL("../src/prs.ts", import.meta.url), "utf8");

describe("mapReviewers", () => {
  test("a person keeps their login; a team is named and flagged as one", () => {
    expect(prs.mapReviewers([
      { requestedReviewer: { login: "rmoreno" } },
      { requestedReviewer: { name: "platform" } },
    ])).toEqual([
      { login: "rmoreno" },
      { login: "platform", isTeam: true },
    ]);
  });

  test("order survives — the row's stack shows the first three and counts the rest", () => {
    const four = ["a", "b", "c", "d"].map((login) => ({ requestedReviewer: { login } }));
    expect(prs.mapReviewers(four).map((r) => r.login)).toEqual(["a", "b", "c", "d"]);
  });

  test("a request with nobody in it is dropped, not drawn as a blank face", () => {
    // GitHub sends these: a review request whose reviewer no longer resolves.
    // The hand-rolled copy needed a `.filter(Boolean)` for exactly this, and a
    // mapper that forgets it puts an avatar of `undefined` on the sidebar.
    expect(prs.mapReviewers([{ requestedReviewer: null }, {}, null])).toEqual([]);
    expect(prs.mapReviewers(null)).toEqual([]);
    expect(prs.mapReviewers(undefined)).toEqual([]);
  });

  test("an empty login is nobody rather than an empty face", () => {
    expect(prs.mapReviewers([{ requestedReviewer: { login: "" } }])).toEqual([]);
    expect(prs.mapReviewers([{ requestedReviewer: { name: "" } }])).toEqual([]);
  });
});

describe("one shape for both views", () => {
  test("the detail builds its reviewers through the same mapper as the row", () => {
    expect(src).toContain("reviewers: mapReviewers(p.reviewRequests?.nodes)");
    // The second copy, which knew nothing about teams and flattened them to a
    // bare name indistinguishable from a person's login.
    expect(src).not.toContain("reviewers: (p.reviewRequests");
    // Not a ban on flattening a reviewer to a string everywhere: the timeline's
    // REVIEWER() does it on purpose, for "requested a review from X", where the
    // name is the whole sentence and no face is ever drawn.
  });
});
