/*
 * A comment you have written and not sent is not a conversation.
 *
 * Reported on a real branch: a line comment drafted in GitHub's own review form
 * and left pending showed up in the panel twice — once as an ordinary open
 * thread, with a Reply box and a Resolve button, and once, right underneath it,
 * as the "drafted on GitHub · sent when you submit" block that is the honest
 * one. The file row counted it in both columns: "3 OPEN · 1 ON GITHUB".
 *
 * The cause is that `reviewThreads` hands your own unsubmitted comments back
 * inside their threads, exactly like posted ones, and the only field that tells
 * the two apart is `state`. It was not being asked for.
 *
 * `threadsFrom` is the seam: the walk around it is `gh`, a subprocess and a
 * network, but the rule about what belongs in a thread is not.
 */
import { describe, expect, it } from "bun:test";
import { threadsFrom } from "../src/prs.ts";

const src = await Bun.file(new URL("../src/prs.ts", import.meta.url)).text();

/** A comment node the way GraphQL returns one, with only what matters here. */
const said = (over: Record<string, unknown> = {}) => ({
  id: "c1", databaseId: 1, author: { login: "octocat" }, body: "posted",
  createdAt: "2020-01-01T00:00:00Z", url: "https://example.invalid/c1",
  diffHunk: "@@ -1 +1 @@", originalLine: 10, state: "SUBMITTED", ...over,
});
const unsent = (over: Record<string, unknown> = {}) => said({ id: "d1", databaseId: 2, body: "draft", state: "PENDING", ...over });
const thread = (comments: unknown[], over: Record<string, unknown> = {}) => ({
  id: "t1", path: "src/thing.py", line: 27, startLine: null,
  isResolved: false, isOutdated: false, comments: { nodes: comments }, ...over,
});

describe("the threads a pull request shows", () => {
  it("leaves out a thread that is nothing but a comment you have not sent", () => {
    expect(threadsFrom([thread([unsent()])])).toEqual([]);
  });

  it("keeps a real thread, without your unsent reply in it", () => {
    const [t] = threadsFrom([thread([said(), unsent({ id: "d2" })])]);
    expect(t.comments.map((c) => c.id)).toEqual(["c1"]);
  });

  it("takes the hunk and the link from the first comment that was actually posted", () => {
    // The unsent one is first in the thread, and it is the one GitHub gives no
    // url for until it is submitted — reading node zero blindly emptied both.
    const [t] = threadsFrom([thread([unsent({ diffHunk: "", originalLine: null, url: "" }), said()])]);
    expect(t.diffHunk).toBe("@@ -1 +1 @@");
    expect(t.originalLine).toBe(10);
    expect(t.url).toBe("https://example.invalid/c1");
  });

  it("keeps an ordinary thread whole", () => {
    const [t] = threadsFrom([thread([said(), said({ id: "c2", body: "reply" })])]);
    expect(t.path).toBe("src/thing.py");
    expect(t.line).toBe(27);
    expect(t.comments.map((c) => c.body)).toEqual(["posted", "reply"]);
  });

  it("survives a pull request with no threads at all", () => {
    expect(threadsFrom(undefined)).toEqual([]);
    expect(threadsFrom(null)).toEqual([]);
    expect(threadsFrom([])).toEqual([]);
    expect(threadsFrom([thread([])])).toEqual([]);
  });

  it("asks GitHub for the field the rule is made of", () => {
    // Without `state` on the comments every thread looks posted, and the filter
    // above silently passes everything — a green suite over the same bug.
    const from = src.indexOf("const SEL_THREADS");
    const sel = src.slice(from, src.indexOf("`;", from));
    expect(sel).toContain("state");
  });
});
