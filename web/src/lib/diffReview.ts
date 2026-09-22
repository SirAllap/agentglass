/*
 * A review of a local diff, sent to an agent as one prompt.
 *
 * The pull request panel already has line comments that collect into a pending
 * review; this is the same shape for the working tree, where the recipient is an
 * agent in a chat rather than GitHub. So the review ends as TEXT: every comment
 * becomes `path:line`, the code it was about, and what was said — the agent is
 * never left finding the code from a description of it.
 *
 * The one thing that makes it survive a working agent: the snippet is captured
 * when the comment is written, not when the review is sent. An agent editing the
 * file moves the anchor; the comment is then shown as stale and still sends the
 * code it was written against. A review that quietly re-anchors to whatever is on
 * that line now is worse than no review.
 *
 * Kept by checkout root, in localStorage: a review is a thing you build up over a
 * few files and several minutes, and navigating to the chat to look something up
 * must not throw it away. Per browser, like the read ticks beside it — this is a
 * draft, not a record.
 */

import type { DiffHunk } from "../../../shared/types.ts";
import { unifiedRows } from "../components/diff/DiffLines.tsx";

export type ReviewSide = "LEFT" | "RIGHT";

export type ReviewComment = {
  id: string;
  path: string;
  /** Which file a line number belongs to: RIGHT is the file as it is now, LEFT
   *  the file before the change. A removed line only has a LEFT number. */
  side: ReviewSide;
  start: number;
  end: number;
  body: string;
  /** The diff lines the comment covers, with their `+`/`-`/space prefix, as they
   *  were when the comment was written. */
  snippet: string[];
  /** Which half of the diff view the comment was written in. A snippet from the
   *  last commit compared against the uncommitted diff would read as stale for no
   *  reason, so staleness is only judged against the same half. */
  mode: "working" | "committed";
  at: number;
};

export type Review = { intro: string; outro: string; comments: ReviewComment[] };

export const EMPTY_REVIEW: Review = { intro: "", outro: "", comments: [] };

/**
 * The diff lines between `start` and `end` on one side, prefixed as a diff is.
 *
 * Everything between the first and the last line in range is taken, including
 * lines of the OTHER side interleaved with them: a comment on two added lines
 * that replaced three removed ones is about the replacement, and a snippet with
 * the removal cut out of the middle would misquote it.
 */
export function captureSnippet(hunks: readonly DiffHunk[], side: ReviewSide, start: number, end: number): string[] {
  const lo = Math.min(start, end), hi = Math.max(start, end);
  const rows = hunks.flatMap((h) => unifiedRows(h));
  const num = (r: (typeof rows)[number]) => (side === "RIGHT" ? r.newN : r.oldN);
  const first = rows.findIndex((r) => { const n = num(r); return n != null && n >= lo && n <= hi; });
  if (first < 0) return [];
  let last = first;
  rows.forEach((r, i) => { const n = num(r); if (n != null && n >= lo && n <= hi) last = i; });
  return rows.slice(first, last + 1).map((r) => (r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ") + r.text);
}

/**
 * Whether the code a comment was written against is no longer at its anchor.
 *
 * `null` hunks — the file is not loaded, or it is the other half of the view —
 * is "cannot tell", which is not stale: a badge that lights for every comment on
 * a file you are not looking at would teach you to ignore it.
 */
export function isStale(c: ReviewComment, hunks: readonly DiffHunk[] | null): boolean {
  if (!hunks) return false;
  const now = captureSnippet(hunks, c.side, c.start, c.end);
  /* Gone from the diff, and it was only ever context: the change beside it was
     undone, which moves nothing the comment is about. A changed line leaving the
     diff is the opposite — somebody reverted exactly what was commented on. */
  if (!now.length && c.snippet.every((l) => l.startsWith(" "))) return false;
  return now.length !== c.snippet.length || now.some((l, i) => l !== c.snippet[i]);
}

/** `path:12` or `path:12-14`, and which file the numbers are in whenever it is
 *  not the file as it is now — an agent reading `:12` goes to line 12 of what is
 *  on disk, and a comment from the last-commit half counts that commit's lines. */
export function anchorLabel(c: Pick<ReviewComment, "path" | "side" | "start" | "end"> & { mode?: ReviewComment["mode"] }): string {
  const lo = Math.min(c.start, c.end), hi = Math.max(c.start, c.end);
  const at = `${c.path}:${lo === hi ? lo : `${lo}-${hi}`}`;
  if (c.mode === "committed") return `${at} (line numbers ${c.side === "LEFT" ? "from before" : "as of"} the last commit)`;
  return c.side === "LEFT" ? `${at} (line numbers from before the change)` : at;
}

/** File order, then line order — the order the prompt lists them in, so the
 *  tray reads the same as what the agent will get. */
export function inReviewOrder(comments: readonly ReviewComment[]): ReviewComment[] {
  return [...comments].sort((a, b) =>
    a.path.localeCompare(b.path) || Math.min(a.start, a.end) - Math.min(b.start, b.end) || a.at - b.at);
}

/**
 * The whole review as one prompt.
 *
 * Comments in file order and then line order, which is the order the agent will
 * walk the code in — not the order they were written, which is the order you
 * happened to scroll. A stale comment says so, so the agent looks for the code
 * rather than trusting the number. `stale` is the set of ids the caller could
 * judge; everything else is sent as written.
 */
export function composeReview(root: string, review: Review, stale: ReadonlySet<string> = new Set()): string {
  const comments = inReviewOrder(review.comments);
  const intro = review.intro.trim()
    || `Review of the changes in ${root}. Address each comment below; each one quotes the code it is about.`;
  const parts = [intro];
  comments.forEach((c, i) => {
    const lines = [`${i + 1}. ${anchorLabel(c)}`];
    if (stale.has(c.id)) lines.push("   (The file has changed since this comment was written — the code below is what it was about; find where it is now.)");
    /* A fence longer than any run of backticks in the snippet, so a snippet that
       contains a fence (a Markdown file, a template) cannot close it early. */
    const ticks = "`".repeat(Math.max(3, ...c.snippet.map((l) => (l.match(/`+/g) ?? []).reduce((n, m) => Math.max(n, m.length + 1), 0))));
    if (c.snippet.length) lines.push(`${ticks}diff`, ...c.snippet, ticks);
    lines.push(c.body.trim());
    parts.push(lines.join("\n"));
  });
  if (review.outro.trim()) parts.push(review.outro.trim());
  return parts.join("\n\n");
}

/**
 * Which chat is "the agent working in that tree".
 *
 * A chat whose directory is the checkout or somewhere inside it — but not inside
 * another checkout nested under it: `.worktrees/` lives under the root it was cut
 * from, and a plain prefix test hands the review to the agent in the worktree,
 * which then edits the wrong tree. So the deepest known root a cwd is under is
 * the one it belongs to, the rule runs.ts already uses for the same reason.
 *
 * One that has already said something beats a fresh tab, and among those the one
 * that spoke last — that is the conversation that made these changes.
 * `undefined` means nobody is working there, and the caller starts a chat for it.
 */
export function chatForTree<T extends { cwd: string; createdAt: number; messages: { ts: number }[] }>(
  chats: readonly T[], root: string, knownRoots: readonly string[] = [],
): T | undefined {
  const under = (cwd: string, r: string) => cwd === r || cwd.startsWith(r.endsWith("/") ? r : `${r}/`);
  const deeper = knownRoots.filter((r) => r !== root && under(r, root));
  const inTree = (cwd: string) => under(cwd, root) && !deeper.some((r) => under(cwd, r));
  const last = (c: T) => c.messages[c.messages.length - 1]?.ts ?? c.createdAt;
  return chats
    .filter((c) => inTree(c.cwd))
    .sort((a, b) => Number(b.messages.length > 0) - Number(a.messages.length > 0) || last(b) - last(a))[0];
}

/** Put the review below whatever is already in a composer, never over it. */
export function withDraft(draft: string, prompt: string): string {
  return draft.trim() ? `${draft.replace(/\s+$/, "")}\n\n${prompt}` : prompt;
}

// --- the store ---------------------------------------------------------------

const KEY = "agentglass.diff.review.v1";

let reviews: Record<string, Review> = load();
const subs = new Set<() => void>();

/**
 * Only entries of the shape this file writes survive a read. The view renders
 * straight from the store, so one entry without its comments — a hand-edited
 * value, a later version's shape — would throw on every load until storage was
 * cleared by hand. A comment that is not whole is dropped rather than repaired:
 * a review that quotes code nobody can see is the thing this is here to prevent.
 */
export function sanitizeReviews(raw: unknown): Record<string, Review> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const str = (v: unknown): v is string => typeof v === "string";
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const out: Record<string, Review> = {};
  for (const [root, r] of Object.entries(raw as Record<string, unknown>)) {
    if (!r || typeof r !== "object" || !Array.isArray((r as Review).comments)) continue;
    const { intro, outro, comments } = r as Review;
    const kept = comments.filter((c): c is ReviewComment => !!c && typeof c === "object"
      && str(c.id) && str(c.path) && str(c.body) && (c.side === "LEFT" || c.side === "RIGHT")
      && (c.mode === "working" || c.mode === "committed") && num(c.start) && num(c.end) && num(c.at)
      && Array.isArray(c.snippet) && c.snippet.every(str));
    out[root] = { intro: str(intro) ? intro : "", outro: str(outro) ? outro : "", comments: kept };
  }
  return out;
}

function load(): Record<string, Review> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    return raw ? sanitizeReviews(JSON.parse(raw)) : {};
  } catch { return {}; }
}

function commit(next: Record<string, Review>) {
  reviews = next;
  try { localStorage.setItem(KEY, JSON.stringify(reviews)); } catch { /* private mode: the review lives until reload */ }
  for (const fn of subs) fn();
}

export function subscribeReviews(fn: () => void): () => void { subs.add(fn); return () => subs.delete(fn); }

/* Another window writing the whole map would otherwise be overwritten by this
   one's older copy on its next keystroke, and the other window's comments gone.
   `storage` fires only in the windows that did NOT write, which is exactly who
   needs to re-read. */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    reviews = load();
    for (const fn of subs) fn();
  });
}
export const reviewFor = (root: string): Review => reviews[root] ?? EMPTY_REVIEW;

let seq = 0;
export function addComment(root: string, c: Omit<ReviewComment, "id" | "at">): ReviewComment {
  const made: ReviewComment = { ...c, id: `r${Date.now().toString(36)}-${++seq}`, at: Date.now() };
  const cur = reviewFor(root);
  commit({ ...reviews, [root]: { ...cur, comments: [...cur.comments, made] } });
  return made;
}

export function editComment(root: string, id: string, body: string) {
  const cur = reviewFor(root);
  commit({ ...reviews, [root]: { ...cur, comments: cur.comments.map((c) => (c.id === id ? { ...c, body } : c)) } });
}

export function removeComment(root: string, id: string) {
  const cur = reviewFor(root);
  commit({ ...reviews, [root]: { ...cur, comments: cur.comments.filter((c) => c.id !== id) } });
}

export function setFrame(root: string, frame: Partial<Pick<Review, "intro" | "outro">>) {
  commit({ ...reviews, [root]: { ...reviewFor(root), ...frame } });
}

/** Sent or discarded: the checkout's entry goes, intro and outro with it. */
export function clearReview(root: string) {
  const { [root]: _gone, ...rest } = reviews;
  commit(rest);
}
