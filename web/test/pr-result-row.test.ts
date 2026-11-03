import { describe, expect, test } from "bun:test";
import { resultRow } from "../src/lib/prResultRow.ts";

const pr = (o: Record<string, unknown> = {}) => ({
  number: 1042, title: "Retry the relay handshake", state: "OPEN" as const, isDraft: false,
  humanReview: { people: [{ login: "mara-k", state: "approved" }, { login: "jun-o", state: "approved" }, { login: "ines-p", state: "await" }] },
  ...o,
}) as Parameters<typeof resultRow>[0];

describe("a result row", () => {
  test("open: the tile is green, the lane is where your board files it", () => {
    const r = resultRow(pr(), { lane: "land" });
    expect([r.tone, r.icon, r.state, r.lane]).toEqual(["ok", "pr", "open", "land"]);
    expect(r.approved).toBe(0);
  });
  test("a draft says so and is quiet", () => {
    expect(resultRow(pr({ isDraft: true }), {})).toMatchObject({ tone: "quiet", icon: "draft", state: "draft" });
  });
  test("merged: purple merge tile, no lane, counts who approved", () => {
    const r = resultRow(pr({ state: "MERGED" }), { lane: "land" });
    expect([r.tone, r.icon, r.state, r.lane, r.approved]).toEqual(["merged", "merge", "merged", null, 2]);
  });
  test("closed without merging: red cross tile", () => {
    expect(resultRow(pr({ state: "CLOSED" }), {})).toMatchObject({ tone: "bad", icon: "x", state: "closed" });
  });
  test("a rule that hides it is named, and only for a pull request that could be on the board", () => {
    expect(resultRow(pr(), { hiddenBy: "Hide · is:draft" }).hiddenBy).toBe("Hide · is:draft");
    expect(resultRow(pr(), { hiddenBy: "Hide · is:draft" }).aria).toContain("hidden on your board by Hide · is:draft");
    expect(resultRow(pr({ state: "MERGED" }), { hiddenBy: "x" }).hiddenBy).toBeNull();
  });
  test("a row from an older server with no reviewers does not throw", () => {
    expect(resultRow(pr({ state: "MERGED", humanReview: undefined }), {}).approved).toBe(0);
  });
  test("the reason the search found it is carried through", () => {
    expect(resultRow(pr(), { why: "author mara-k" }).why).toBe("author mara-k");
  });
});
