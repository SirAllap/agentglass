import { blockerWords, type Blocker } from "./blockers.ts";
/*
 * The rich Jira board tile's decisions, as plain functions. The tile is a Jira TASK card: a pull request is information on it
 * (read from what the PR board already loaded) plus a link, never an action on GitHub. The component draws these answers and
 * decides nothing itself.
 */

export interface TileCi { state: "failing" | "passing" | "running" | "unknown"; passed: number; total: number; failing: string[]; /** Checks that failed (failure only; skipped and pending are neither). */ failed: number }
export interface TileReview { kind: "approved" | "changes" | "awaiting" | "commented" | "none" | "unknown"; who: string | null }
export interface TilePr {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED" | "";
  draft: boolean;
  url: string;
  title?: string;
  base: string | null;
  /** Head branch, from the project read; null when the list did not carry it. */
  branch: string | null;
  ci: TileCi;
  review: TileReview;
  /** Commits the base has that the branch lacks; null while nobody asked git. */
  behind: number | null;
  additions: number | null;
  deletions: number | null;
  /** GitHub's verdict from the project read; "CONFLICTING" is the one the card draws. */
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
}

export type HeaderKind = "blocked" | "child-blocked" | "worker" | "ci-failing" | "waiting" | "ready" | "quiet";
export interface TileHeader { kind: HeaderKind; text: string }

export interface TileChild { key: string; status: string; kind: "done" | "progress" | "todo" | "blocked" }
/** Two rows of squares at most: past this many they fold into a count. */
export const CHILD_SQUARES_MAX = 28;
/** An umbrella's children: done of total, one square per child in order (two rows max), and the first blocked child to open. */
export function childBar(children: readonly TileChild[] | undefined): { done: number; total: number; squares: TileChild["kind"][]; hidden: number; blocked: { key: string; count: number } | null } | null {
  if (!children?.length) return null;
  const blocked = children.filter((c) => c.kind === "blocked");
  return {
    done: children.filter((c) => c.kind === "done").length, total: children.length,
    squares: children.slice(0, CHILD_SQUARES_MAX).map((c) => c.kind), hidden: Math.max(0, children.length - CHILD_SQUARES_MAX),
    blocked: blocked.length ? { key: blocked[0]!.key, count: blocked.length } : null,
  };
}

const isOpen = (p: TilePr) => p.state === "OPEN";
const asking = (p: TilePr) => isOpen(p) && !p.draft;

/**
 * The one thing that needs the person, in this order: a blocker, a running worker, failing checks, a reviewer who has not
 * answered, an approved and green lead, else nothing. A draft asks nobody; checks not read yet claim nothing.
 */
export function tileHeader(i: { blockedBy: readonly Blocker[]; worker: boolean; prs: readonly TilePr[]; children?: readonly TileChild[] | undefined }): TileHeader {
  const words = blockerWords(i.blockedBy);
  if (words) return { kind: "blocked", text: words.short };
  const bk = i.children?.filter((c) => c.kind === "blocked") ?? [];
  if (bk.length) return { kind: "child-blocked", text: `${bk.length} ${bk.length === 1 ? "child" : "children"} blocked · ${bk[0]!.key}` };
  if (i.worker) return { kind: "worker", text: "Worker running" };
  const bad = i.prs.find((p) => isOpen(p) && p.ci.state === "failing");
  if (bad) {
    const n = bad.ci.failed;
    return { kind: "ci-failing", text: `${n} ${n === 1 ? "check" : "checks"} failing${bad.ci.failing[0] ? ` · ${bad.ci.failing[0]}` : ""}` };
  }
  const wait = i.prs.find((p) => asking(p) && p.review.kind === "awaiting");
  if (wait) return { kind: "waiting", text: `Waiting on ${wait.review.who ?? "a reviewer"} · review` };
  const ok = i.prs.find((p) => asking(p) && p.review.kind === "approved" && p.ci.state === "passing");
  if (ok) return { kind: "ready", text: `Lead #${ok.number} approved · CI ${ok.ci.passed}/${ok.ci.total}` };
  return { kind: "quiet", text: "Nothing needs you" };
}

const norm = (s: string) => s.trim().toLowerCase();
/** The card's status as a chip, or null when it only repeats the lane it sits in. `lane` null: the lane is not a status. */
export function tileStatusChip(status: string, lane: string | null): string | null {
  return lane !== null && norm(status) === norm(lane) ? null : status;
}

const rank = (p: Pick<TilePr, "state" | "draft">) => (p.state === "OPEN" && !p.draft ? 0 : p.draft ? 1 : p.state === "MERGED" ? 2 : 3);
/** Own PRs: up to two draw inline; three or more draw the lead (the open one first) and "+N". */
export function inlinePrs<T extends Pick<TilePr, "state" | "draft" | "number">>(own: readonly T[]): { inline: T[]; more: number } {
  const sorted = [...own].sort((a, b) => rank(a) - rank(b) || b.number - a.number);
  if (sorted.length <= 2) return { inline: sorted, more: 0 };
  return { inline: [sorted[0]!], more: sorted.length - 1 };
}

/** What a compact tile keeps of the PRs: the lead one (the open one first) and how many more there are. Null when the card has none. */
export function compactPrChip<T extends Pick<TilePr, "state" | "draft" | "number">>(own: readonly T[]): { lead: T; more: number } | null {
  if (!own.length) return null;
  const sorted = [...own].sort((x, y) => rank(x) - rank(y) || y.number - x.number);
  return { lead: sorted[0]!, more: sorted.length - 1 };
}

/** A card that is only mentioned by pull requests: a link icon and the count, never a PR row. */
export function mentionChip(n: number): { count: number; tip: string } | null {
  return n > 0 ? { count: n, tip: `${n} ${n === 1 ? "mention" : "mentions"}` } : null;
}

export interface Box { left: number; top: number; right: number; bottom: number }
const GAP = 4;
/**
 * Where the popover opens, in the same coordinates as the boxes. Inside its lane on every side: below the anchor if it fits,
 * else above it, and never above the lane's top edge, so it cannot cover the header of a tile (or the lane) above.
 */
export function popoverPlacement(anchor: Box, lane: Box, pop: { w: number; h: number }): { left: number; top: number; flip: boolean } {
  const maxLeft = Math.max(lane.left, lane.right - pop.w);
  const left = Math.min(Math.max(anchor.left, lane.left), maxLeft);
  const below = anchor.bottom + GAP;
  const fitsBelow = below + pop.h <= lane.bottom;
  if (fitsBelow) return { left, top: below, flip: false };
  const above = anchor.top - GAP - pop.h;
  if (above >= lane.top) return { left, top: above, flip: true };
  return { left, top: Math.max(lane.top, Math.min(below, lane.bottom - pop.h)), flip: false };
}

export type TileAction =
  | { kind: "open-blocker"; label: string; key: string; all: string; count: number; disabled: null }
  | { kind: "open-worker"; label: string; disabled: null }
  | { kind: "open-child"; label: string; key: string; disabled: null }
  | { kind: "move-next"; label: string; to: string; disabled: string | null }
  | { kind: "flight-plan"; label: string; disabled: null }
  | { kind: "assign"; label: string; disabled: string | null };
const OFF = "Changes in Jira is off: turn it on in Settings to move or assign cards";
/**
 * The Jira actions on the tile: one primary, one more on hover. Nothing here touches GitHub (a PR is read-only, with its own
 * link). Opening runs at once; Move and Assign are Jira writes (off with the write switch, and confirmed like a drop or in the
 * card pane); Start flight plan opens the composer, which is its confirm.
 */
/** Who the card belongs to, from the viewer's side: the rule for which action a tile may offer reads this, not the status word. */
export type TileOwner = "me" | "other" | "nobody";
/** Undefined when Jira's answer does not say whose it is (no connected account id): the tile then keeps today's buttons rather than guess. */
export const tileOwner = (c: { mine?: boolean | undefined; people?: readonly { me?: boolean | undefined }[] | undefined; assignees?: readonly string[] | undefined }): TileOwner | undefined => {
  /* A card from an older cache or a payload without the field has nobody listed: read it as empty, never crash the tile. */
  const named = c.assignees?.length ?? 0;
  if (c.mine === true || c.people?.some((p) => p.me)) return "me";
  if (c.mine === undefined) return named ? undefined : "nobody";
  return named ? "other" : "nobody";
};

export function tileAction(i: { blockedBy: readonly Blocker[]; worker: boolean; header: HeaderKind; nextStatus: string | null; writable: boolean; childKey?: string | undefined; owner?: TileOwner | undefined; done?: boolean | undefined }): { primary: TileAction | null; secondary: TileAction | null } {
  /* A finished card offers nothing: Start flight plan and Assign on a Done card were the noise that made every tile look alike. */
  if (i.done) return { primary: null, secondary: null };
  const words = blockerWords(i.blockedBy);
  if (words) return { primary: { kind: "open-blocker", label: `Open ${words.first}`, key: words.first, all: words.tip, count: i.blockedBy.length, disabled: null }, secondary: null };
  /* Somebody else's card: reading what blocks it is the only thing that is not their call. */
  if (i.owner === "other") return { primary: null, secondary: null };
  if (i.header === "child-blocked" && i.childKey) return { primary: { kind: "open-child", label: "Open blocked child", key: i.childKey, disabled: null }, secondary: null };
  if (i.worker) return { primary: { kind: "open-worker", label: "Open worker", disabled: null }, secondary: null };
  const off = i.writable ? null : OFF;
  /* Nobody owns it: the one honest action is to give it an owner, named for what it does. Starting work on a card nobody holds is not offered. */
  if (i.owner === "nobody") return { primary: { kind: "assign", label: "Choose an owner", disabled: off }, secondary: null };
  /* The tile's one primary is the next move on the board, whatever the card's header says. Start flight plan used to fill this slot when there was no move; it stays reachable from the card's own menu, and an empty slot is better than a button nobody presses. */
  const primary: TileAction | null = i.nextStatus ? { kind: "move-next", label: `Move to ${i.nextStatus}`, to: i.nextStatus, disabled: off } : null;
  return { primary, secondary: { kind: "assign", label: i.owner === "me" ? "Hand over" : "Assign", disabled: off } };
}

/** What a tile button does, said on hover before it is pressed: a button that writes to Jira says so and says what it writes. */
export function actionTip(a: TileAction, key: string): { name: string; text: string } {
  if (a.disabled) return { name: a.label, text: a.disabled };
  switch (a.kind) {
    case "open-blocker": return { name: a.label, text: a.count > 1 ? `${a.all} block ${key}. Open the first to see what it waits on.` : `${a.key} blocks ${key}. Open it to see what it waits on.` };
    case "open-child": return { name: a.label, text: `${a.key}, a sub-task of ${key}, is blocked. Open it.` };
    case "open-worker": return { name: a.label, text: `An agent is working on ${key}. Open its terminal.` };
    case "move-next": return { name: a.label, text: `Moves ${key} to ${a.to} in Jira. You confirm before it is sent.` };
    case "flight-plan": return { name: a.label, text: `Write a plan for ${key} before any work starts.` };
    case "assign": return { name: a.label, text: `Pick who holds ${key} in Jira. You confirm before it is sent.` };
  }
}

/** The header line's hover: what the one line means and where it came from. */
export const HEADER_TIP: Record<HeaderKind, string> = {
  blocked: "A linked card blocks this one in Jira.",
  "child-blocked": "One of its sub-tasks is blocked.",
  worker: "An agent is working on this card now.",
  "ci-failing": "Checks fail on this card's lead pull request.",
  waiting: "A reviewer has not answered the pull request yet.",
  ready: "The lead pull request is approved and its checks pass.",
  quiet: "Nothing on this card waits for you.",
};

export type MoveUi = { phase: "moving"; to: string } | { phase: "failed"; to: string; reason: string };
/**
 * What the tile's move action shows while the board's own move is in flight or after it failed. `ui` is the board's move result
 * (never a second move path); only a move action wears it.
 */
export function moveView(ui: MoveUi | undefined, primary: TileAction | null): { label: string; busy: boolean; error: string | null; retryTo: string | null } {
  const label = primary?.label ?? "";
  if (!ui) return { label, busy: false, error: null, retryTo: null };
  // A failure is said whatever the tile offers now: the person asked for a move and it did not happen.
  if (ui.phase === "failed") return { label, busy: false, error: `Move failed: ${ui.reason}`, retryTo: ui.to };
  if (primary?.kind !== "move-next") return { label, busy: false, error: null, retryTo: null };
  return { label: "Moving…", busy: true, error: null, retryTo: null };
}

/** Below this lane width a ticket keeps #n, state and CI and drops the review/behind/+− row and the base branch. */
export const NARROW_LANE_PX = 260;
export function ticketLayout(laneWidth: number): { facts: boolean; base: boolean } {
  const narrow = laneWidth > 0 && laneWidth < NARROW_LANE_PX;
  return { facts: !narrow, base: !narrow };
}

/**
 * Whether the tile's action row folds its second button (Hand over / Assign) into the card's "..." menu, which has an
 * Assign row of its own. Measured on a 280 px tile: the primary move button, Hand over, the mention chip and "..." did
 * not fit, and the flex row cut a label ("Move to Sh...") and left Hand over's last letter on the border. A label is
 * never cut to make room, so what does not fit is not drawn. The widths are an estimate (11px semi-bold is about
 * 6.6 px a letter, 10 px of padding a side); an unknown lane width (0) folds nothing. Ceiling: an estimate, not a
 * measurement, so a very wide font setting can still crowd the row; the primary then truncates its status name.
 */
export const ACT_LETTER_PX = 6.6;
export const ACT_PAD_PX = 20;
export const ACT_GAP_PX = 6;
export const TILE_PAD_PX = 24;
export const ACT_DOTS_PX = 26;
export const ACT_MENTION_PX = 40;
export function foldSecondary(i: { laneWidth: number; primary: string; secondary: string; mentions: boolean }): boolean {
  if (i.laneWidth <= 0) return false;
  const btn = (label: string): number => Math.ceil(label.length * ACT_LETTER_PX) + ACT_PAD_PX;
  const parts = [btn(i.primary), btn(i.secondary), ACT_DOTS_PX, ...(i.mentions ? [ACT_MENTION_PX] : [])];
  const need = parts.reduce((a, b) => a + b, 0) + ACT_GAP_PX * (parts.length - 1);
  return need > i.laneWidth - TILE_PAD_PX;
}
