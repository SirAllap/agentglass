// A review of a local diff, turned into one prompt for the agent in that tree.
//
// What can go wrong here is all text: a snippet that quotes the wrong lines, a
// comment that loses its code when the agent edits the file, a prompt whose
// fence is closed early by the code it quotes, or a review handed to a chat in
// some other checkout. Pure functions, no DOM.
import { test, expect } from "bun:test";
import type { DiffHunk } from "../../shared/types.ts";
import {
  addComment, anchorLabel, captureSnippet, chatForTree, checkAtSend, clearReview, composeReview, editComment,
  isStale, removeComment, reviewFor, sanitizeReviews, setFrame, withDraft, type ReviewComment,
} from "../src/lib/diffReview.ts";

const PAGE = await Bun.file(new URL("../src/components/diff/DiffPage.tsx", import.meta.url)).text();

// orbit/src/cart.ts: two lines replaced by one, with context either side.
const hunks: DiffHunk[] = [{
  oldStart: 10, oldLines: 4, newStart: 10, newLines: 3,
  lines: [" const items = cart.items;", "-let total = 0;", "-for (const i of items) total += i.price;", "+const total = sum(items.map((i) => i.price));", " return total;"],
}];

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "c1", path: "src/cart.ts", side: "RIGHT", start: 11, end: 11, body: "sum() drops the discount",
  snippet: ["-let total = 0;"], mode: "working", at: 1, ...over,
});

// --- the snippet -------------------------------------------------------------

test("a comment on an added line quotes that line", () => {
  expect(captureSnippet(hunks, "RIGHT", 11, 11)).toEqual(["+const total = sum(items.map((i) => i.price));"]);
});

test("a range keeps the removals it spans, so the replacement is not misquoted", () => {
  expect(captureSnippet(hunks, "RIGHT", 10, 12)).toEqual([
    " const items = cart.items;", "-let total = 0;", "-for (const i of items) total += i.price;",
    "+const total = sum(items.map((i) => i.price));", " return total;",
  ]);
});

test("a removed line is found by its old number, and a range given backwards still works", () => {
  expect(captureSnippet(hunks, "LEFT", 12, 11)).toEqual(["-let total = 0;", "-for (const i of items) total += i.price;"]);
});

test("a line the diff does not show quotes nothing", () => {
  expect(captureSnippet(hunks, "RIGHT", 40, 41)).toEqual([]);
});

test("a range across two hunks marks the lines it skips", () => {
  // Shift-click from one hunk into the next: the label says :11-41, and two
  // hunks run together would quote code 30 lines apart as if it were adjacent.
  const two: DiffHunk[] = [hunks[0]!, { oldStart: 40, oldLines: 2, newStart: 39, newLines: 3, lines: [" }", "+export { total };", " "] }];
  expect(captureSnippet(two, "RIGHT", 11, 40)).toEqual([
    "+const total = sum(items.map((i) => i.price));", " return total;", "@@ … @@", " }", "+export { total };",
  ]);
});

test("context either side of a skipped gap is still context", () => {
  const two: DiffHunk[] = [hunks[0]!, { oldStart: 40, oldLines: 2, newStart: 39, newLines: 3, lines: [" }", "+export { total };", " "] }];
  const c = comment({ start: 12, end: 39, snippet: captureSnippet(two, "RIGHT", 12, 39) });
  expect(c.snippet).toEqual([" return total;", "@@ … @@", " }"]);
  expect(isStale(c, [])).toBe(false);
});

// --- staleness ---------------------------------------------------------------

test("a comment is current while its code is still at its anchor", () => {
  const c = comment({ snippet: captureSnippet(hunks, "RIGHT", 11, 11) });
  expect(isStale(c, hunks)).toBe(false);
});

test("the agent edits the line, the comment turns stale and keeps the code it was written against", () => {
  const c = comment({ snippet: captureSnippet(hunks, "RIGHT", 11, 11) });
  const edited: DiffHunk[] = [{ ...hunks[0]!, lines: hunks[0]!.lines.map((l) => l.startsWith("+") ? "+const total = subtotal(items);" : l) }];
  expect(isStale(c, edited)).toBe(true);
  const sent = composeReview("/code/orbit", { intro: "", outro: "", comments: [c] }, new Set([c.id]));
  expect(sent).toContain("+const total = sum(items.map((i) => i.price));");
  expect(sent).not.toContain("subtotal");
});

test("the anchor falling out of the diff altogether is stale too", () => {
  expect(isStale(comment({ snippet: captureSnippet(hunks, "RIGHT", 11, 11) }), [])).toBe(true);
});

test("a comment on an unchanged line is not stale when the change beside it is undone", () => {
  // The line leaves the diff because nothing near it is changed any more; its own
  // code never moved, so there is nothing to warn about.
  expect(isStale(comment({ snippet: [" const items = cart.items;"] }), [])).toBe(false);
});

test("a file that is not loaded is not stale — it cannot be told", () => {
  expect(isStale(comment(), null)).toBe(false);
});

// --- the prompt --------------------------------------------------------------

test("the prompt names file and line, quotes the code, and says what was said", () => {
  const snippet = captureSnippet(hunks, "RIGHT", 11, 11);
  const p = composeReview("/home/dev/orbit", { intro: "", outro: "", comments: [comment({ snippet })] });
  expect(p).toContain("Review of the changes in /home/dev/orbit");
  expect(p).toContain("1. src/cart.ts:11\n```diff\n+const total = sum(items.map((i) => i.price));\n```\nsum() drops the discount");
});

test("the intro and outro frame it when written, and comments go in file then line order", () => {
  const p = composeReview("/r", {
    intro: "Before you commit:", outro: "Then run the tests.",
    comments: [
      comment({ id: "b", path: "src/z.ts", start: 3, end: 3, body: "third", at: 1 }),
      comment({ id: "a", path: "src/a.ts", start: 9, end: 9, body: "second", at: 2 }),
      comment({ id: "c", path: "src/a.ts", start: 2, end: 4, body: "first", at: 3 }),
    ],
  });
  expect(p.startsWith("Before you commit:\n\n1. src/a.ts:2-4")).toBe(true);
  expect(p.indexOf("first")).toBeLessThan(p.indexOf("second"));
  expect(p.indexOf("second")).toBeLessThan(p.indexOf("third"));
  expect(p.endsWith("\n\nThen run the tests.")).toBe(true);
});

test("a stale comment is sent with its captured code and a warning to look for it", () => {
  const p = composeReview("/r", { intro: "", outro: "", comments: [comment()] }, new Set(["c1"]));
  expect(p).toContain("has changed since this comment was written");
  expect(p).toContain("-let total = 0;");
});

test("old-side numbers say so, because :12 means the file as it is now", () => {
  expect(anchorLabel({ path: "a.ts", side: "LEFT", start: 12, end: 12 })).toBe("a.ts:12 (line numbers from before the change)");
  expect(anchorLabel({ path: "a.ts", side: "RIGHT", start: 5, end: 3 })).toBe("a.ts:3-5");
});

test("a comment from the last-commit half says its numbers are the commit's", () => {
  expect(anchorLabel({ path: "a.ts", side: "RIGHT", start: 4, end: 4, mode: "committed" })).toBe("a.ts:4 (line numbers as of the last commit)");
  expect(anchorLabel({ path: "a.ts", side: "LEFT", start: 4, end: 4, mode: "committed" })).toBe("a.ts:4 (line numbers from before the last commit)");
});

test("code that holds a fence cannot close the snippet's", () => {
  const p = composeReview("/r", { intro: "", outro: "", comments: [comment({ snippet: ["+```ts", "+x", "+```"] })] });
  expect(p).toContain("````diff\n+```ts\n+x\n+```\n````");
});

// --- who gets it -------------------------------------------------------------

test("at send time every commented file is checked, not only the one on screen", async () => {
  // Comments on two files; the agent edited a.ts while b.ts was on screen.
  const a = comment({ id: "a1", path: "a.ts", snippet: captureSnippet(hunks, "RIGHT", 11, 11) });
  const a2 = comment({ id: "a2", path: "a.ts", start: 10, end: 10, snippet: captureSnippet(hunks, "RIGHT", 10, 10) });
  const b = comment({ id: "b1", path: "b.ts", snippet: captureSnippet(hunks, "RIGHT", 11, 11) });
  const edited: DiffHunk[] = [{ ...hunks[0]!, lines: hunks[0]!.lines.map((l) => l.startsWith("+") ? "+const total = subtotal(items);" : l) }];
  const asked: string[] = [];
  const got = await checkAtSend([a, a2, b], async (path, mode) => {
    asked.push(`${path}@${mode}`);
    return path === "a.ts" ? edited : hunks;
  });
  expect([...got.stale]).toEqual(["a1"]);
  expect(got.files).toEqual([{ path: "a.ts", mode: "working", stale: 1, of: 2, unknown: false }]);
  expect(asked.sort()).toEqual(["a.ts@working", "b.ts@working"]);
});

test("a file whose diff cannot be fetched is warned about as unchecked, not passed as current", async () => {
  const c = comment({ id: "c1", path: "gone.ts", snippet: ["+x"] });
  const got = await checkAtSend([c], async () => { throw new Error("404"); });
  expect(got.stale.size).toBe(0);
  expect(got.files).toEqual([{ path: "gone.ts", mode: "working", stale: 0, of: 1, unknown: true }]);
});

test("nothing stale anywhere means nothing to warn about", async () => {
  const c = comment({ id: "c1", snippet: captureSnippet(hunks, "RIGHT", 11, 11) });
  expect((await checkAtSend([c], async () => hunks)).files).toEqual([]);
});

const chat = (id: string, cwd: string, lastTs: number | null, createdAt = 0) =>
  ({ id, cwd, createdAt, messages: lastTs == null ? [] : [{ ts: lastTs }] });

test("the chat that last spoke in the tree gets the review", () => {
  const got = chatForTree([
    chat("other", "/code/orbit-api", 900),
    chat("old", "/code/orbit", 100),
    chat("new", "/code/orbit/", 500),
    chat("fresh", "/code/orbit", null, 999),
  ], "/code/orbit");
  expect(got?.id).toBe("new");
});

test("a clean worktree nested under the checkout never receives its review", () => {
  // The worktree has nothing uncommitted, so no list of changed files knows it
  // is a checkout; its agent spoke last. The review is still the outer tree's.
  const chats = [chat("main", "/code/orbit", 1), chat("nested", "/code/orbit/.worktrees/feat", 9)];
  expect(chatForTree(chats, "/code/orbit")?.id).toBe("main");
  expect(chatForTree(chats, "/code/orbit/.worktrees/feat")?.id).toBe("nested");
  expect(chatForTree([chat("nested", "/code/orbit/.worktrees/feat", 9)], "/code/orbit")).toBeUndefined();
});

test("a chat in a folder below the root is not taken for the tree's agent", () => {
  // It could be a nested checkout nobody has listed; a new chat at the root is
  // the safe answer, a review in the wrong tree is not.
  expect(chatForTree([chat("sub", "/code/orbit/web", 9)], "/code/orbit")).toBeUndefined();
});

test("a sibling checkout whose name starts the same is not in the tree", () => {
  expect(chatForTree([chat("sib", "/code/orbit-v2", 1)], "/code/orbit")).toBeUndefined();
});

test("a fresh tab in the tree is used when nobody has spoken there", () => {
  expect(chatForTree([chat("fresh", "/code/orbit", null)], "/code/orbit")?.id).toBe("fresh");
});

test("the review goes under a half-written draft, never over it", () => {
  expect(withDraft("", "R")).toBe("R");
  expect(withDraft("also check the tests  \n", "R")).toBe("also check the tests\n\nR");
});

// --- the store ---------------------------------------------------------------

test("a stored review of the wrong shape is dropped, not trusted", () => {
  // One entry missing its comments and one comment missing its snippet: either
  // would throw on the first render of the diff view, on every load after.
  const good = { id: "g", path: "a.ts", side: "RIGHT", start: 1, end: 1, body: "b", snippet: ["+x"], mode: "working", at: 1 };
  const got = sanitizeReviews({
    "/r1": { intro: "" },
    "/r2": { intro: "i", outro: "o", comments: [good, { ...good, id: "h", snippet: undefined }] },
    "/r3": "nonsense",
  });
  expect(Object.keys(got)).toEqual(["/r2"]);
  expect(got["/r2"]!.comments.map((c) => c.id)).toEqual(["g"]);
  expect(sanitizeReviews(null)).toEqual({});
  expect(sanitizeReviews([1, 2])).toEqual({});
});

test("comments collect per checkout, edit, remove and clear", () => {
  const root = "/code/orbit-store-test";
  const a = addComment(root, { path: "a.ts", side: "RIGHT", start: 1, end: 1, body: "one", snippet: ["+x"], mode: "working" });
  addComment(root, { path: "b.ts", side: "RIGHT", start: 2, end: 2, body: "two", snippet: ["+y"], mode: "working" });
  expect(reviewFor("/code/elsewhere").comments).toHaveLength(0);
  editComment(root, a.id, "uno");
  setFrame(root, { intro: "hi" });
  expect(reviewFor(root).comments.map((c) => c.body)).toEqual(["uno", "two"]);
  expect(reviewFor(root).intro).toBe("hi");
  removeComment(root, a.id);
  expect(reviewFor(root).comments.map((c) => c.body)).toEqual(["two"]);
  clearReview(root);
  expect(reviewFor(root)).toEqual({ intro: "", outro: "", comments: [] });
});

test("removing the last comment takes the intro and outro with it", () => {
  // The tray hides at zero comments, so a frame left behind would be sent,
  // unseen, at the head and tail of the next review on this checkout.
  const root = "/code/orbit-frame-test";
  const a = addComment(root, { path: "a.ts", side: "RIGHT", start: 1, end: 1, body: "one", snippet: ["+x"], mode: "working" });
  setFrame(root, { intro: "hi", outro: "run the tests" });
  removeComment(root, a.id);
  expect(reviewFor(root)).toEqual({ intro: "", outro: "", comments: [] });
});

test("the tray is keyed by checkout, so an armed Discard does not carry to another", () => {
  // Discard arms on the first press and fires on the second. Without a key the
  // armed state survives selecting a file in another checkout, and the second
  // press throws away that checkout's review instead.
  expect(PAGE).toMatch(/<ReviewTray key=\{root\}/);
});

test("Send review opens a terminal with an agent already on it, not a chat draft", () => {
  // Option (1): the same move conflict resolution already makes
  // (PrPanel.tsx's "Hand to Claude in a terminal", requestTermIssue) — a NEW
  // tmux window, in the checkout's own worktree, with an agent started on the
  // composed review. It used to park the review as an unsent draft in
  // whichever chat was open in the tree; that composer step is gone.
  const from = PAGE.indexOf("const deliver = useCallback(");
  expect(from).toBeGreaterThan(-1);
  const deliver = PAGE.slice(from, PAGE.indexOf("\n  }, [", from))
    .split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
  expect(deliver).toContain("requestTermIssue(");
  expect(deliver).not.toContain("c.draft = withDraft(");
  expect(deliver).not.toMatch(/\bseedChat\(/);
});
