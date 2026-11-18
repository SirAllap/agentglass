/*
 * The side pane beside a terminal: what each worker tab remembers about it.
 *
 * A tab here is a tmux window (or, without tmux, the focused shell). Per tab:
 * whether the pane is open, which section it shows, how wide it is and where each
 * section was scrolled. Only the pin and the compact mode are the machine's, and
 * only those two are written down; the rest lives as long as the window.
 *
 * Nothing in here holds a component or a fetched card: the pane mounts its content
 * for the tab on screen and lets it go on a switch, so what stays behind is a few
 * numbers per tab.
 *
 * The view itself (this file's own job) lives in the SAME per-tab record as
 * the card, branch, pull request and diff (lib/tabFacts.ts) — one row per
 * tab, not two parallel stores that could drift. The functions below are
 * unchanged on the outside; underneath, they read and write `liveTabFacts`'s
 * `view` field instead of a store of their own.
 */
import { liveTabFacts, type SideSection, type SplitSection } from "./tabFacts.ts";
export type { SideSection, SplitSection } from "./tabFacts.ts";

export const SIDE_SECTIONS: readonly SideSection[] = ["card", "pr", "diff"];

export const SIDE_MIN = 360;
export const SIDE_DEFAULT = 520;
export const SIDE_COMPACT = 300;
export const SIDE_MAX_SHARE = 0.65;
export const DIVIDER_PX = 5;
/** What xterm reserves for its scrollbar, per terminal column group. */
export const SIDE_SCROLLBAR_PX = 16;
/** The seam between two split terminals. */
export const SIDE_PAIR_GAP_PX = 24;
/** Kept clear of the row's left edge when the pane is drawn over the terminal. */
export const SIDE_OVERLAY_MARGIN_PX = 40;
/** A terminal cell's width before the first measure. */
export const SIDE_CELL_FALLBACK_PX = 8;
/** The terminal never gets narrower than this many columns. */
export const MIN_TERM_COLS = 80;

const PIN_KEY = "agentglass.sidePane.pinned";
const COMPACT_KEY = "agentglass.sidePane.compact";

const read = (k: string): boolean => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };
const write = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch { /* private mode: it lasts the session */ } };

let pinned = read(PIN_KEY);
let compact = read(COMPACT_KEY);
/** Pin/compact changes only — a view change notifies through `liveTabFacts`
 *  itself, which `subscribeSidePane` also listens to below. */
let version = 0;
const subs = new Set<() => void>();
const bump = () => { version++; subs.forEach((f) => f()); };

export const subscribeSidePane = (fn: () => void): (() => void) => {
  subs.add(fn);
  const offFacts = liveTabFacts.subscribe(fn);
  return () => { subs.delete(fn); offFacts(); };
};
/** Changes whenever EITHER the pin/compact pair or any tab's view does —
 *  `useSyncExternalStore` only needs a value that differs, not a true count. */
export const sidePaneVersion = (): number => version * 1_000_000 + (liveTabFacts.version() % 1_000_000);

export interface SidePaneView {
  open: boolean; section: SideSection; width: number | null; pinned: boolean; compact: boolean;
  maxWidth: boolean; split: boolean; splitSection: SplitSection;
}

export function viewOf(tab: string): SidePaneView {
  const v = liveTabFacts.get(tab)?.view;
  return {
    open: v?.open ?? pinned, section: v?.section ?? "card", width: v?.width ?? null, pinned, compact,
    maxWidth: v?.maxWidth ?? false, split: v?.split ?? false, splitSection: v?.splitSection ?? "diff",
  };
}

/** Open the pane on this tab, on `section` when given. */
export function openSide(tab: string, section?: SideSection): void {
  liveTabFacts.setView(tab, { open: true, ...(section ? { section } : {}) });
}
export function closeSide(tab: string): void { liveTabFacts.setView(tab, { open: false }); }
export function setSection(tab: string, section: SideSection): void {
  if (liveTabFacts.get(tab)?.view.section !== section) liveTabFacts.setView(tab, { section });
}
export function setWidth(tab: string, width: number | null): void {
  if (liveTabFacts.get(tab)?.view.width !== width) liveTabFacts.setView(tab, { width });
}
/** Pinning opens the pane on tabs that were closed earlier; a tab the person opened keeps its own answer, so unpinning does not close it. */
export function togglePin(): boolean {
  pinned = !pinned;
  if (pinned) for (const id of liveTabFacts.tabIds()) if (liveTabFacts.get(id)?.view.open === false) liveTabFacts.setView(id, { open: undefined });
  write(PIN_KEY, pinned); bump(); return pinned;
}
export function toggleCompact(): boolean { return setCompact(!compact); }
export function setCompact(v: boolean): boolean { if (compact !== v) { compact = v; write(COMPACT_KEY, compact); bump(); } return compact; }
/** Turning max width off also drops the split: a split body makes no sense at normal width. */
export function toggleMaxWidth(tab: string): boolean {
  const next = !(liveTabFacts.get(tab)?.view.maxWidth ?? false);
  liveTabFacts.setView(tab, next ? { maxWidth: next } : { maxWidth: next, split: false });
  return next;
}
/** Split implies max width: there is no room for a card-beside-diff body otherwise. */
export function toggleSplit(tab: string): boolean {
  const next = !(liveTabFacts.get(tab)?.view.split ?? false);
  liveTabFacts.setView(tab, next ? { split: next, maxWidth: true } : { split: next });
  return next;
}
export function setSplitSection(tab: string, section: SplitSection): void {
  if (liveTabFacts.get(tab)?.view.splitSection !== section) liveTabFacts.setView(tab, { splitSection: section });
}
/** The split's right half: "pr" only when the checkout actually has one, else "diff". */
export function effectiveSplitSection(requested: SplitSection, hasPr: boolean): SplitSection {
  return requested === "pr" && !hasPr ? "diff" : requested;
}
export function scrollOf(tab: string, key: string): number { return liveTabFacts.get(tab)?.view.scroll[key as SideSection] ?? 0; }
/** Not a notification: a scroll position changes nothing anybody draws. */
export function rememberScroll(tab: string, key: string, px: number): void {
  liveTabFacts.rememberScroll(tab, key as SideSection, px);
}
/** Whether a view `clientH` tall holding `scrollH` of content can be scrolled to `want`; false while the content is still too short. */
export function canRestore(want: number, scrollH: number, clientH: number): boolean { return scrollH - clientH >= want; }
/** Drops the tab's WHOLE record — the window closed, so its card, branch, pull
 *  request and diff go with its view. */
export function forgetTab(tab: string): void { liveTabFacts.forget(tab); }

/**
 * Whether an optimistic window switch can stop overriding tmux's own list.
 *
 * `pending` is the window a click already jumped to, ahead of tmux's own
 * answer. It must stand until that answer actually agrees — tmux's window
 * list gets a fresh array on EVERY poll frame, whether or not anything in it
 * changed, so clearing on "the array changed" (its old contract) dropped the
 * override within one poll, routinely before the select had even landed, and
 * the active id fell back to the window tmux still thought was active: the
 * tab that was just left. Resolved only by content: tmux confirms `pending` as
 * the active window, or the window is gone (closed underneath the click) —
 * either way tmux's own next answer is the one to trust.
 */
/**
 * "Which window is active", answered once and read by the strip, the chip bar
 * and the side pane alike — so they cannot disagree about it for even one
 * render. Before this was two separate expressions: the strip read
 * `pendingWindow` (the window a click already jumped to) and the chip
 * bar/side pane read tmux's own pushed list only. Both were computed from the
 * SAME `tmuxWindows` in the SAME render, so the only difference was whether
 * `pendingWindow` was consulted — and for as long as tmux's own select+push
 * round trip took, the bar and the pane kept answering for the window the
 * click had just left, under the tab the strip had already highlighted.
 */
export function resolveActiveWindow(pending: string | null, windows: readonly { id: string; active: boolean }[]): string | null {
  if (pending && windows.some((w) => w.id === pending)) return pending;
  return windows.find((w) => w.active)?.id ?? null;
}

export function pendingResolved(pending: string | null, windows: readonly { id: string; active: boolean }[]): boolean {
  if (!pending) return true;
  const w = windows.find((x) => x.id === pending);
  return !w || w.active;
}

/**
 * Windows that closed between two reads of ONE session's window list. A different
 * session, or an empty list (a reconnect between frames), proves nothing closed.
 */
export function closedWindows(prev: { sid: string; ids: readonly string[] } | null, sid: string, now: readonly string[]): string[] {
  if (!prev || prev.sid !== sid || now.length === 0) return [];
  const live = new Set(now);
  return prev.ids.filter((id) => !live.has(id));
}

/** Whether the pane could be drawn at all: a checkout is open, terminal commands are on, and the row has been measured. */
export function sideCanShow(hasRoot: boolean, commandsOff: boolean, rowW: number): boolean {
  return hasRoot && !commandsOff && rowW > 0;
}

/** Test seam. */
export function resetSidePane(): void { liveTabFacts.reset(); pinned = false; compact = false; bump(); }

/**
 * The pane's width for a row `total` px wide whose terminal needs `termMinPx` to
 * keep its 80 columns. The ceiling is the smaller of that and 65% of the row; the
 * floor is 360 unless the ceiling is lower, and compact mode is 300 under the same
 * ceiling. The ceiling wins over the floor: the terminal's columns are the promise.
 */
export function paneWidth(want: number | null, total: number, termMinPx: number, isCompact: boolean): number {
  const room = Math.max(0, total - DIVIDER_PX - termMinPx);
  const max = Math.min(total * SIDE_MAX_SHARE, room);
  if (isCompact) return Math.max(0, Math.min(SIDE_COMPACT, max));
  return Math.max(0, Math.min(max, Math.max(SIDE_MIN, want ?? SIDE_DEFAULT)));
}

/** Width for a divider drag that ended with the pointer at `pointerX`, measured from the row's left edge. */
export function dragWidth(pointerX: number, total: number, termMinPx: number): number {
  return paneWidth(total - DIVIDER_PX - pointerX, total, termMinPx, false);
}

/** A pane narrower than this has no room for anything worth reading: the row says so instead. */
export const SIDE_USABLE = 200;

/** Section for a digit key (1/2/3), or null. */
export function sectionForKey(key: string): SideSection | null {
  return key === "1" ? "card" : key === "2" ? "pr" : key === "3" ? "diff" : null;
}

export const EMBEDDED_LIST_MIN_PX = 120;
export const EMBEDDED_LIST_DEFAULT_PX = 200;
/** Below this row width the file column cannot show a name: it folds into a dropdown. */
export const EMBEDDED_LIST_FOLD_PX = 340;
/** Leaves the diff at least this much of the pane. */
export const EMBEDDED_DIFF_MIN_PX = 180;
export function embeddedListMax(rowW: number): number { return Math.max(EMBEDDED_LIST_MIN_PX, rowW - EMBEDDED_DIFF_MIN_PX); }

/** How far to move a popup sideways so it sits inside [boundLeft, boundRight]: the side pane's edges, or the viewport's. */
export function menuShift(left: number, right: number, boundLeft: number, boundRight: number, margin = 8): number {
  if (left < boundLeft + margin) return boundLeft + margin - left;
  if (right > boundRight - margin) return Math.min(0, boundRight - margin - right);
  return 0;
}

/** Sections kept mounted (hidden) so coming back to a tab shows what it had, with no refetch and no skeleton. */
export const KEEP_SECTIONS = 6;

export function keepAlive<T extends { id: string }>(list: T[], cur: T, max = KEEP_SECTIONS): T[] {
  const prev = list.find((e) => e.id === cur.id);
  const next = [...list.filter((e) => e.id !== cur.id), { ...prev, ...cur }];
  return next.length > max ? next.slice(next.length - max) : next;
}

const listWidths = new Map<string, number>();
const LIST_KEY = "agentglass.sidePane.listWidth";

/** The diff file list's width for one tab; a tab that never set one starts from the last width chosen anywhere. */
export function listWidthOf(tab: string): number {
  const own = listWidths.get(tab);
  if (own) return own;
  try { const v = Number(localStorage.getItem(LIST_KEY)); if (v >= EMBEDDED_LIST_MIN_PX) return v; } catch { /* default */ }
  return EMBEDDED_LIST_DEFAULT_PX;
}

export function setListWidth(tab: string, px: number): void {
  listWidths.set(tab, px);
  try { localStorage.setItem(LIST_KEY, String(px)); } catch { /* non-fatal */ }
}
