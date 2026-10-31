/*
 * A pull request link that ends in the comment it means.
 *
 * GitHub's own URL for a line comment, a conversation comment and a review all
 * end in a fragment; the panel finds the entry by the URL it already holds,
 * because the DOM carries GraphQL node ids and the fragment a numeric one.
 */
import { describe, expect, it } from "bun:test";
import { prAnchorFromUrl } from "../src/lib/openPrs.ts";
import { anchorTarget, takeAnchor } from "../src/lib/prMention.ts";

const PR = "https://github.com/acme/orbit/pull/553";

describe("prAnchorFromUrl", () => {
  it("reads the three comment shapes", () => {
    expect(prAnchorFromUrl(`${PR}#discussion_r4359351454`)).toBe("discussion_r4359351454");
    expect(prAnchorFromUrl(`${PR}#issuecomment-123`)).toBe("issuecomment-123");
    expect(prAnchorFromUrl(`${PR}#pullrequestreview-9`)).toBe("pullrequestreview-9");
  });
  it("is null with no fragment, an unknown one, or a half-typed one", () => {
    for (const u of [PR, `${PR}#diff-abc`, `${PR}#r2`, `${PR}#discussion_r`, `${PR}#issuecomment-1x`, null, undefined])
      expect(prAnchorFromUrl(u as string)).toBeNull();
  });
});

describe("anchorTarget", () => {
  const files = [{ path: ".github/workflows/build.yml" }, { path: "tools/thing/pyproject.toml" }];
  const th = (id: string, over: object, urls: string[]) =>
    ({ id, path: "tools/thing/pyproject.toml", line: 3, isOutdated: false, comments: urls.map((url) => ({ url })), ...over });
  const detail = {
    files,
    comments: [{ nodeId: "IC_1", url: `${PR}#issuecomment-123` }, { nodeId: null, url: `${PR}#issuecomment-5` }],
    reviews: [{ nodeId: "PRR_1", url: `${PR}#pullrequestreview-9` }],
    threads: [
      th("PRT_open", {}, [`${PR}#discussion_r77`, `${PR}#discussion_r78`]),
      th("PRT_resolved", { isResolved: true, line: 9 }, [`${PR}#discussion_r80`]),
      th("PRT_old", { isOutdated: true, line: null }, [`${PR}#discussion_r90`]),
      th("PRT_old_kept_line", { isOutdated: true }, [`${PR}#discussion_r92`]),
      th("PRT_gone", { path: "removed/file.py" }, [`${PR}#discussion_r91`]),
    ],
  };
  it("in the diff, unresolved: its own file, its line, its thread", () => {
    expect(anchorTarget(detail, "discussion_r77")).toEqual({ tab: "files", path: "tools/thing/pyproject.toml", line: 3, thread: "PRT_open" });
  });
  it("in the diff, resolved: the same, the panel unfolds it", () => {
    expect(anchorTarget(detail, "discussion_r80")).toEqual({ tab: "files", path: "tools/thing/pyproject.toml", line: 9, thread: "PRT_resolved" });
  });
  it("a reply in a thread lands on the thread", () => {
    expect(anchorTarget(detail, "discussion_r78")).toEqual({ tab: "files", path: "tools/thing/pyproject.toml", line: 3, thread: "PRT_open" });
  });
  it("outdated, or on a file the diff lost: Conversation, never a file", () => {
    expect(anchorTarget(detail, "discussion_r90")).toEqual({ tab: "conversation", thread: "PRT_old" });
    expect(anchorTarget(detail, "discussion_r92")).toEqual({ tab: "conversation", thread: "PRT_old_kept_line" });
    expect(anchorTarget(detail, "discussion_r91")).toEqual({ tab: "conversation", thread: "PRT_gone" });
  });
  it("conversation comment and review go to their node", () => {
    expect(anchorTarget(detail, "issuecomment-123")).toEqual({ tab: "conversation", node: "IC_1" });
    expect(anchorTarget(detail, "pullrequestreview-9")).toEqual({ tab: "conversation", node: "PRR_1" });
  });
  it("not among the loaded threads: the fetched comment names the file", () => {
    expect(anchorTarget(detail, "discussion_r500", { path: "tools/thing/pyproject.toml", line: 3 })).toEqual({ tab: "files", path: "tools/thing/pyproject.toml", line: 3 });
    expect(anchorTarget(detail, "discussion_r500", { path: "tools/thing/pyproject.toml", line: null })).toEqual({ tab: "conversation" });
    expect(anchorTarget(detail, "discussion_r500", { path: "removed/file.py", line: 3 })).toEqual({ tab: "conversation" });
  });
  it("missing: Conversation, nothing to scroll to; a longer id is not a match", () => {
    expect(anchorTarget(detail, "discussion_r1")).toEqual({ tab: "conversation" });
    expect(anchorTarget(detail, "discussion_r7")).toEqual({ tab: "conversation" });
    expect(anchorTarget(detail, "issuecomment-5")).toEqual({ tab: "conversation" });
    expect(anchorTarget({}, "issuecomment-5")).toEqual({ tab: "conversation" });
  });
});

describe("takeAnchor", () => {
  const want = { number: 553, anchor: "discussion_r1" };
  it("cold: waits for the detail, serves once it is this pull request's, then nothing is pending", () => {
    let st = takeAnchor(want, null);
    expect(st).toEqual({ serve: null, pending: want });
    st = takeAnchor(st.pending, { number: 12 }); // the previous pull request's detail
    expect(st.serve).toBeNull();
    st = takeAnchor(st.pending, { number: 553 });
    expect(st).toEqual({ serve: want, pending: null });
    expect(takeAnchor(st.pending, { number: 553 }).serve).toBeNull(); // exactly once
  });
  it("cached or already open: the detail is there when the request lands, so it serves at once", () => {
    expect(takeAnchor(want, { number: 553 })).toEqual({ serve: want, pending: null });
  });
  it("nothing asked: nothing served", () => {
    expect(takeAnchor(null, { number: 553 })).toEqual({ serve: null, pending: null });
  });
});
