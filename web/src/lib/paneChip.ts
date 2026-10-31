/*
 * What the pane chip says, decided without a DOM.
 *
 * The chip is one design in many states (a worktree with a pull request, one
 * without, a main checkout, a checkout outside the project, a read still in
 * flight…), and the component that draws it grew a branch per state. The
 * decisions are here instead: which parts exist, in which order, how much of a
 * branch name survives, what colour a CI dot is allowed to be, and which of two
 * readings of a pull request is the newer. The component only draws the answer.
 *
 * Ceiling: the parts are chosen from the pane's width alone. A tmux pane inside
 * a wider xterm is measured by the caller (paneFoot) and arrives here as a width.
 */
import type { PrBranchSummary, PrCheckRollup } from "../../../shared/types.ts";

// ── the trigger ─────────────────────────────────────────────────────────────

/** How the bar shows up. `off` draws nothing; the other three draw the same chip. */
export type PaneBarMode = "edge" | "summary" | "always" | "off";
export const PANE_BAR_MODES: readonly PaneBarMode[] = ["edge", "summary", "always", "off"];

/**
 * The mode a machine gets when it has never chosen one.
 *
 * A new install gets the quiet strip; a machine that already had ANY state
 * stored keeps the thin line it has been using, so an update never changes what
 * somebody's panes look like under them.
 */
export function defaultPaneBarMode(hadState: boolean): PaneBarMode {
  return hadState ? "edge" : "summary";
}

/** Height, in px, a mode keeps free under every pane. The thin line keeps none. */
export const STRIP_H: Record<PaneBarMode, number> = { edge: 0, summary: 26, always: 36, off: 0 };

// ── the parts and their order ───────────────────────────────────────────────

export type ChipKind = "worktree" | "main" | "outside" | "none" | "loading";

/** Left to right, always. A missing part leaves its place empty or is skipped,
 *  but no part ever changes sides, so a control is where the hand left it. */
export const PART_ORDER = ["kind", "name", "copy", "sep", "sync", "card", "pr", "diff"] as const;
export type ChipPart = (typeof PART_ORDER)[number];

/** Below this the words (Diff, PR, the card id) go, then copy and sync. */
export const NARROW_W = 420;

export interface ChipFacts {
  kind: ChipKind;
  /** A pull request exists for the branch (any state). */
  hasPr: boolean;
  hasCard: boolean;
  ahead: number;
  behind: number;
  width: number;
}

export function chipParts(f: ChipFacts): { parts: ChipPart[]; words: boolean } {
  const narrow = f.width < NARROW_W;
  const parts: ChipPart[] = ["kind", "name"];
  if (f.kind === "worktree" || f.kind === "main") {
    if (!narrow) parts.push("copy", "sep");
    if (!narrow && (f.ahead > 0 || f.behind > 0)) parts.push("sync");
    if (f.hasCard) parts.push("card");
    // A worktree with no pull request keeps a dashed slot so PR and Diff never
    // move between states; a main checkout has no pull request to want.
    if (f.hasPr || f.kind === "worktree") parts.push("pr");
    parts.push("diff");
  }
  return { parts, words: !narrow };
}

// ── the branch name ─────────────────────────────────────────────────────────

/** Cut in the middle, because a branch is named for what it does at the END. */
export function cutMiddle(s: string, max: number): string {
  if (s.length <= max || max < 6) return s;
  const h = Math.ceil((max - 1) * 0.45), t = Math.floor((max - 1) * 0.55);
  let head = s.slice(0, h), tail = s.slice(s.length - t);
  // Snap each side to a "-" word boundary when that keeps at least half of it
  // (shortcut: "-" only, "/" and "_" cut mid-word).
  const hb = head.lastIndexOf("-");
  if (s[h] !== "-" && hb >= h / 2) head = head.slice(0, hb);
  const tb = tail.indexOf("-");
  if (s[s.length - t - 1] !== "-" && tb >= 0 && tb <= t / 2) tail = tail.slice(tb + 1);
  return head + "…" + tail;
}

/** Rough px of every part but the name (measured at 11px; a card id is the wide one). */
const PART_PX: Record<ChipPart, [number, number]> = { kind: [22, 22], name: [0, 0], copy: [22, 22], sep: [5, 5], sync: [40, 40], card: [110, 30], pr: [80, 56], diff: [80, 45] };

/**
 * Room the bar's branch name has, from the pane's width and the parts drawn.
 * Not measured off the name's own box: that box is as wide as its text when the
 * bar is content-sized, so the cut text fed back as the next budget and a wide
 * pane read "VR…ll". Never under 24 characters.
 */
export function chipNameChars(width: number, parts: ChipPart[], words: boolean): number {
  const used = parts.reduce((a, x) => a + PART_PX[x][words ? 0 : 1] + 4, 0);
  return Math.max(24, charsFor(width - 16 - 8 - used - 12));
}

/** Room the pill's branch name has: its width less the icon, padding, PR and dirty marks. */
export const pillNameChars = (footW: number, hasPr: boolean, dirty: boolean): number =>
  Math.max(24, charsFor(footW - 16 - 38 - (hasPr ? 56 : 0) - (dirty ? 34 : 0)));

/** How many mono characters fit in a box this wide, at the chip's 11px. */
export const CHAR_W = 6.6;
export const charsFor = (px: number): number => Math.max(6, Math.floor(px / CHAR_W));

/**
 * The card id the card chip already shows is greyed, and is the first thing to
 * go; only then is the rest cut in the middle.
 */
export function branchLabel(branch: string, cardId: string | null | undefined, max: number): { pre: string; text: string } {
  const id = cardId ?? "";
  const hasPre = id !== "" && branch.toLowerCase().startsWith(`${id.toLowerCase()}-`);
  if (hasPre && branch.length <= max) return { pre: branch.slice(0, id.length + 1), text: branch.slice(id.length + 1) };
  return { pre: "", text: cutMiddle(hasPre ? branch.slice(id.length + 1) : branch, max) };
}

// ── the pull request ────────────────────────────────────────────────────────

export type PrReading = Pick<PrBranchSummary, "number" | "state" | "isDraft" | "reviewDecision">;
export type PrFact = Pick<PrBranchSummary, "state" | "isDraft" | "reviewDecision"> & { at: number };

/**
 * The pull request for THIS pane's branch, or nothing.
 *
 * A reading remembers the root and branch it was asked for. Without the check, a
 * pane that moved to another branch drew the last branch's pull request until
 * the new answer landed.
 */
export function prForPane<T extends { root: string; branch: string }>(held: T | null, root: string, branch: string): T | null {
  return held && held.root === root && held.branch === branch ? held : null;
}

/** Two readings of one pull request: the newer wins. The Pull requests view
 *  writes the same store, so "merged" there is "merged" here. */
export function freshestPr<T extends PrReading>(read: T, readAt: number, fact: PrFact | null | undefined): T {
  if (!fact || fact.at <= readAt) return read;
  return { ...read, state: fact.state, isDraft: fact.isDraft, reviewDecision: fact.reviewDecision };
}

/** A check read older than this is not drawn: a state that outlives its
 *  reading is a lie told confidently. */
export const CHECKS_FRESH_MS = 5 * 60_000;

export type PrState = "open" | "draft" | "merged" | "closed";
export type ChecksState = "passing" | "running" | "failing" | "none-read-yet" | "error";
export type ReviewState = "approved" | "changes" | "pending" | "none";

export interface ChecksView { state: ChecksState; passed: number; total: number; failing: string[] }

export const prState = (pr: Pick<PrBranchSummary, "state" | "isDraft">): PrState =>
  pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";

export const reviewOf = (d: PrBranchSummary["reviewDecision"] | undefined, state: PrState): ReviewState =>
  state === "merged" || state === "closed" ? "none" : d === "APPROVED" ? "approved" : d === "CHANGES_REQUESTED" ? "changes" : d === "REVIEW_REQUIRED" ? "pending" : "none";

/**
 * What the checks are, from what was read and when.
 *
 * Unknown is unknown: no reading is `none-read-yet`, a reading that failed or
 * has expired is `error` (a neutral state, never the last colour forever), and
 * only a fresh reading says passing, running or failing.
 */
/** What the checks ring says in words. */
export const checksWords = (c: ChecksView): string =>
  c.state === "failing" ? `${c.passed} of ${c.total} checks passed, ${c.failing.length} failing`
  : c.state === "passing" ? `${c.passed} of ${c.total} checks passed`
  : c.state === "running" ? `checks running, ${c.passed} of ${c.total} passed`
  : c.state === "error" ? "checks could not be read" : "checks not read yet";

/** The pull-request chip's accessible name. The green mark on the ring is the
 *  REVIEW, not the checks, so the sentence names the review as such: with
 *  unreadable checks and an approval, "…could not be read, approved" read as if
 *  the check mark vouched for the checks. */
export function prChipLabel(pr: { number: number; state: string }, checks: ChecksView, review: string | null | undefined): string {
  const rv = review === "approved" ? ", review approved" : review === "changes" ? ", changes requested" : review === "pending" ? ", review pending" : "";
  return `Pull request ${pr.number}, ${pr.state}, ${checksWords(checks)}${rv}. Opens Pull requests.`;
}

export function checksOf(read: { checks: PrCheckRollup | null; at: number } | null | undefined, now = Date.now()): ChecksView {
  if (!read) return { state: "none-read-yet", passed: 0, total: 0, failing: [] };
  const c = read.checks;
  if (!c || now - read.at > CHECKS_FRESH_MS) return { state: "error", passed: 0, total: 0, failing: [] };
  const base = { passed: c.success, total: c.total, failing: c.failing.map((f) => f.name) };
  if (c.failure > 0) return { state: "failing", ...base };
  if (c.pending > 0 || !c.allDone) return { state: "running", ...base };
  return c.verdict === "green" ? { state: "passing", ...base } : { state: "error", passed: 0, total: 0, failing: [] };
}

// ── the card ────────────────────────────────────────────────────────────────

/** The status square, only when the tracker answered with a status. */
export function cardSquare(status: string | null | undefined, color: string | null | undefined): { color: string; title: string } | null {
  if (!status) return null;
  return { color: color || "var(--text4)", title: status };
}

// ── the Summary pill ────────────────────────────────────────────────────────

/** The pill's width in px, margins included: what the last line must stay clear of. */
export const PILL_W = 200;

/**
 * Where the Summary pill sits so it never hides text somebody is reading.
 *
 * `lastEnd` is how many columns of the pane's bottom row are occupied (text or
 * the cursor); `aboveEnd` the same for the row over it. Clear of both, the pill
 * stays at the foot. Under the last row's text it moves up one row; when the
 * row above is occupied there too it has nowhere to go and only turns
 * translucent. Ceiling: it looks at two rows; a pane whose three bottom rows
 * all run under the pill keeps the translucent pill and nothing smarter.
 */
export function pillPlacement(o: { cols: number; pillCols: number; lastEnd: number; aboveEnd: number }): { lift: boolean; translucent: boolean } {
  const from = o.cols - o.pillCols;
  if (o.lastEnd <= from) return { lift: false, translucent: false };
  if (o.aboveEnd > from) return { lift: false, translucent: true };
  return { lift: true, translucent: true };
}

/** The part of xterm's active buffer this needs: a row's text and where the cursor is. */
export interface PlacementBuffer {
  viewportY: number;
  cursorX: number;
  cursorY: number;
  getLine(y: number): { translateToString(trimRight?: boolean, start?: number, end?: number): string } | undefined;
}

/**
 * Summary's pill placement read off a terminal buffer: how much of the pane's
 * bottom two rows is occupied (text, or the cursor standing there), against the
 * columns the pill covers. `c0`..`c1` are the pane's own columns (a tmux pane
 * is a rectangle of cells in one canvas) and `bottom` its last row.
 */
export function bufferPlacement(buf: PlacementBuffer, o: { c0: number; c1: number; bottom: number; cellW: number }): { lift: boolean; translucent: boolean } {
  const occupied = (row: number) => {
    const ln = row >= 0 ? buf.getLine(buf.viewportY + row) : undefined;
    let end = ln ? ln.translateToString(true, o.c0, o.c1 + 1).length : 0;
    if (buf.cursorY === row) end = Math.max(end, buf.cursorX - o.c0 + 1);
    return end;
  };
  return pillPlacement({ cols: o.c1 - o.c0 + 1, pillCols: Math.ceil(PILL_W / (o.cellW || 8)), lastEnd: occupied(o.bottom), aboveEnd: occupied(o.bottom - 1) });
}

/**
 * What a key does inside the bar: Esc gives the keyboard back to the terminal,
 * the arrows walk the controls (clamped, not wrapped), Home and End jump.
 * `at` is the focused control's index, `count` how many there are.
 */
export function barKey(key: string, at: number, count: number): { escape: true } | { focus: number } | null {
  if (key === "Escape") return { escape: true };
  if (count <= 0) return null;
  if (key === "Home") return { focus: 0 };
  if (key === "End") return { focus: count - 1 };
  if (key === "ArrowRight") return { focus: Math.min(count - 1, at + 1) };
  if (key === "ArrowLeft") return { focus: Math.max(0, at - 1) };
  return null;
}
