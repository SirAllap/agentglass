/*
 * The tab's own record: card, branch, pull request, diff and the pane's own
 * view — one row per tmux window id, nothing else.
 *
 * Before this, the same facts lived in half a dozen places at once: a
 * pane-content cache keyed by window:pane (`wtSeen`), a global identity
 * cache keyed the same way (`paneIdentity.ts`), a branch+root-keyed pull
 * request cache, and two module-level maps for a card's status and a diff's
 * totals keyed by `root:branch`. None of those keys is the tab — a pane's
 * content, a window:pane pair and a root:branch pair are all facts ABOUT a
 * tab, but none of them IS one, and three tabs that share one cwd (a worker
 * standing in the parent checkout, reaching into its own worktree by
 * absolute path rather than `cd`) produce the exact same pane content,
 * window-focus noise and root:branch pair for all three — so whichever
 * tab's read happened to run last answered for the other two as well.
 *
 * One record per tmux window id instead. Nothing here is ever read or
 * written by a cwd, a pane id, a "currently focused" slot, or another tab's
 * key. A tab that was never written answers `undefined` — "never read" is a
 * value, not a reason to invent one from a cousin's answer.
 */

import type { ChecksView, PrState, ReviewState } from "./paneChip.ts";

export type SideSection = "card" | "pr" | "diff";

export interface CardFact {
  label: string;
  /** What the finder is handed — see lib/cardRef.ts's `CardRef.query`. */
  query: string;
  tracker?: "jira";
  status: string | null;
  color: string | null;
  priority: string | null;
  /** Where a click on the card goes: the board, or an address needing no
   *  credentials — see lib/cardRef.ts's `chipAction`. `null`: nowhere. */
  action: { in: "tasks" } | { in: "away"; url: string } | null;
}

export interface PrFact {
  repo: string;
  number: number;
  title: string;
  state: PrState;
  author: string;
  base: string;
  checks: ChecksView;
  review: ReviewState;
  reviewWord?: string;
}

export interface DiffFact {
  files: number;
  add: number;
  del: number;
}

/** What one tab's pane remembers about itself: which section is open, how
 *  wide it is, where each section was scrolled, and whether it is open at
 *  all (`undefined` follows the machine-wide pin). */
export type SplitSection = "pr" | "diff";

export interface TabView {
  open?: boolean;
  section: SideSection;
  width: number | null;
  scroll: Partial<Record<SideSection, number>>;
  /** The pane at its widest (SIDE_MAX_SHARE), not its chosen width. */
  maxWidth?: boolean;
  /** Body split in two at max width: card on the left, `splitSection` on the right. */
  split?: boolean;
  splitSection?: SplitSection;
}

export interface TabFacts {
  tabId: string;
  /** The checkout this tab's card/branch/diff are about; null while nothing
   *  has resolved one yet — see `resolveWorktree`. */
  root: string | null;
  branch: string;
  card: CardFact | null;
  pr: PrFact | null;
  diff: DiffFact | null;
  /** The card's status as the card section itself read it, for a tracker
   *  (Jira) whose status never reaches `card.status` any other way — see
   *  SidePane.tsx's `useStatus`. */
  jiraStatus: { title: string; color: string | null } | null;
  /** When this record was last written, epoch ms. 0 for a record nothing has
   *  written to yet (`fresh()`, never handed out by `get`). */
  at: number;
  view: TabView;
}

const freshView = (): TabView => ({ section: "card", width: null, scroll: {} });
const fresh = (tabId: string): TabFacts => ({ tabId, root: null, branch: "", card: null, pr: null, diff: null, jiraStatus: null, at: 0, view: freshView() });

/** The fields a refresh may write; never `tabId` (fixed at creation) and
 *  never `view` (its own setter merges instead of replacing). */
export type FactsPatch = Partial<Omit<TabFacts, "tabId" | "view" | "at">>;

export interface TabFactsStore {
  /** The record as it stands, or `undefined` for a tab nothing has written
   *  yet — never a guess, never another tab's record. */
  get(tabId: string): TabFacts | undefined;
  /** Every record's own tab id, for a scheduler or a store test to iterate. */
  tabIds(): string[];
  /** Merges `patch` into `tabId`'s own record. Always keyed by the id the
   *  caller names explicitly — there is no "current" or "active" tab for
   *  this call to default to, which is what keeps a response for A that
   *  lands after a switch to B out of B's record. */
  write(tabId: string, patch: FactsPatch): void;
  /** Merges into `tabId`'s own view; `scroll` merges key by key rather than
   *  replacing the whole map, so remembering one section's scroll never
   *  forgets another's. */
  setView(tabId: string, patch: Partial<Omit<TabView, "scroll">> & { scroll?: Partial<Record<SideSection, number>> }): void;
  /** Remembers one section's scroll position, quietly: a scroll position
   *  changes nothing anybody draws, so — unlike `setView` — this never
   *  notifies a subscriber. */
  rememberScroll(tabId: string, section: SideSection, px: number): void;
  /** Drops a tab's whole record — the window closed. */
  forget(tabId: string): void;
  getActive(): string | null;
  /** A pure setter: changing the active tab writes nothing and fetches
   *  nothing by itself. Drawing is `get(getActive())`; refreshing is a
   *  caller's separate, explicit choice (`refreshTargets`). */
  setActive(tabId: string | null): void;
  subscribe(fn: () => void): () => void;
  version(): number;
  /** Test/reload seam: every record and the active tab, gone. */
  reset(): void;
}

export function createTabFactsStore(): TabFactsStore {
  const rows = new Map<string, TabFacts>();
  let active: string | null = null;
  let version = 0;
  const subs = new Set<() => void>();
  const bump = () => { version++; subs.forEach((f) => f()); };
  const ensure = (tabId: string): TabFacts => {
    let r = rows.get(tabId);
    if (!r) { r = fresh(tabId); rows.set(tabId, r); }
    return r;
  };
  return {
    get: (tabId) => rows.get(tabId),
    tabIds: () => [...rows.keys()],
    // A fresh object every write, never a mutation of the one handed out
    // before: `useSyncExternalStore` (React) decides whether to redraw by
    // comparing the reference `get` returns across renders, and a record
    // mutated in place would hand back the SAME reference forever — the
    // exact shape of bug this store exists to rule out, one layer up.
    // A write that changes nothing is dropped, not stored and announced.
    // Effects in TerminalPanel write the tab's root and branch every time
    // they run; each announce redraws every subscriber, which re-ran those
    // effects, and the loop ended in React's "Maximum update depth exceeded"
    // (#185) on the terminal view.
    write: (tabId, patch) => {
      const r = rows.get(tabId);
      if (r && (Object.keys(patch) as (keyof FactsPatch)[]).every((k) => JSON.stringify(r[k]) === JSON.stringify(patch[k]))) return;
      rows.set(tabId, { ...ensure(tabId), ...patch, at: Date.now() });
      bump();
    },
    setView: (tabId, patch) => {
      const r = ensure(tabId);
      const { scroll, ...rest } = patch;
      rows.set(tabId, { ...r, view: { ...r.view, ...rest, scroll: scroll ? { ...r.view.scroll, ...scroll } : r.view.scroll } });
      bump();
    },
    rememberScroll: (tabId, section, px) => {
      const r = ensure(tabId);
      rows.set(tabId, { ...r, view: { ...r.view, scroll: { ...r.view.scroll, [section]: px } } });
    },
    forget: (tabId) => { if (rows.delete(tabId)) bump(); },
    getActive: () => active,
    setActive: (tabId) => { if (active !== tabId) { active = tabId; bump(); } },
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    version: () => version,
    reset: () => { rows.clear(); active = null; bump(); },
  };
}

/**
 * The tab's bound card: launch metadata first (pinned, authoritative,
 * exactly for the case two cards share a display name), the tab's own name
 * otherwise, or none.
 */
export function resolveCardId(
  tabName: string | undefined | null,
  launchCardId: string | undefined | null,
  labelFromName: (name: string) => string | null,
): { kind: "launch" | "name" | "none"; cardId: string | null } {
  if (launchCardId) return { kind: "launch", cardId: launchCardId };
  const fromName = tabName ? labelFromName(tabName) : null;
  if (fromName) return { kind: "name", cardId: fromName };
  return { kind: "none", cardId: null };
}

/**
 * The checkout a tab's branch/diff come from.
 *
 * The bound card decides first, when one of the candidates' own branches
 * names it (`namedWorktree`, paneWorktree.ts) — the one signal that still
 * tells two tabs apart once their cwd stops discriminating. Without a bound
 * card, or with one nothing names, the tab's OWN cwd decides — the checkout
 * actually AT that path, found by equality, never a worktree some other
 * session's pane content happened to mention. No scanning of `work` or
 * `dirs` here at all: that scan is exactly what let one tab's transcript
 * answer for another's.
 */
export function resolveWorktree<T extends { root: string; branch: string }>(
  cardId: string | null,
  cwd: string,
  cands: readonly T[],
  named: (cardId: string | null, cands: readonly T[]) => T | null,
): T | null {
  /* The checkout that CONTAINS the cwd, the deepest one: an agent standing in
     `<worktree>/server` is in that worktree, and equality alone read it as in
     none and fell back to the project's main checkout. */
  let hit: T | null = null;
  for (const r of cands) {
    if ((cwd === r.root || cwd.startsWith(r.root.replace(/\/+$/, "") + "/")) && (!hit || r.root.length > hit.root.length)) hit = r;
  }
  return named(cardId, cands) ?? hit;
}

/**
 * Which tabs refresh at the normal rate: the active one, and only it — never
 * zero because nothing is active, never more than one. Every other tab is
 * left alone: no slow background poll, no request at all, until it becomes
 * active and draws its last-written record while its own fresh read runs.
 */
export function refreshTargets(tabIds: readonly string[], activeId: string | null): string[] {
  return activeId !== null && tabIds.includes(activeId) ? [activeId] : [];
}

/** One tab's refresh: fetches, then writes ONLY that tab's own record — the
 *  id the fetch was issued for, read from this closure, never "whichever tab
 *  is active when the response lands". */
export type TabFetcher = (tabId: string) => Promise<FactsPatch>;

/** Refreshes exactly the targets `refreshTargets` names, in parallel, each
 *  write going to its own tab regardless of what becomes active meanwhile. */
export function refreshActive(store: TabFactsStore, tabIds: readonly string[], fetchFacts: TabFetcher): Promise<void>[] {
  return refreshTargets(tabIds, store.getActive()).map((id) => fetchFacts(id).then((patch) => { store.write(id, patch); }));
}

/**
 * The one record store the whole app reads and writes — the bottom bar, the
 * side pane, and every tab's own slot in the strip, alike. A store factory
 * exists above for tests (a fresh, isolated store per test); the running app
 * needs exactly one, for the same reason `sessions` in TerminalPanel.tsx is
 * one module-level map rather than one per component instance.
 */
export const liveTabFacts: TabFactsStore = createTabFactsStore();
