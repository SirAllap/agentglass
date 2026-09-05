// The pages open in the built-in browser, and what happens to the list when
// one is opened, closed or lands somewhere new.
//
// A separate module because none of this is about Electron: it is a list, a
// selection, and the small rules that make a tab strip behave the way people
// expect — which one gets focus when you close the one you were on, what a tab
// is CALLED before its page has a title, and how many may be open at once.
// Kept out of the component so it can be tested without a browser, and so the
// component is left with rendering.

import { BLANK } from "./browserPrefs.ts";

export interface BrowserTab {
  /** Stable for the life of the tab: it keys the <webview> that must not be
   *  torn down and rebuilt when the list is reordered. */
  id: string;
  /** Where the page actually is, as the guest reports it. */
  url: string;
  /** What the guest is loading, if anything — the address bar shows this. */
  title: string;
  /** The site's own icon, when it has offered one. */
  icon: string | null;
  loading: boolean;
  /** The main frame failed. Sub-frames are not the page. */
  failed: string | null;
  canBack: boolean;
  canForward: boolean;
  /**
   * Restored from last session and not yet opened.
   *
   * An asleep tab is a name, an icon and an address — no guest, no processes,
   * no network. It wakes the first time it is selected. Without this, "reopen
   * my tabs" would mount twelve Chromium guests at launch inside an app that
   * is also running a fleet of agents, which is the very cost MAX_TABS exists
   * to bound.
   */
  asleep?: boolean;
  /** Which browsing profile this tab belongs to; "" is the default one.
   *
   *  Fixed for the life of the tab, and not an oversight: a guest's partition is
   *  decided when it attaches, so moving a tab between profiles would mean
   *  destroying it and loading the page again in a new one. A new tab in the
   *  other profile is the same thing without pretending it is the same tab. */
  profile: string;
  /**
   * The shelf item this tab IS, when it was opened from one.
   *
   * Identity, not address. The binding used to be "the tab whose url matches
   * the kept one", and that is only true until you click a link: opening a kept
   * page and pressing History inside it moved the tab out of its folder and
   * into the loose list, which reads as the browser having opened a second tab
   * — his words, "it opens a new tab... when it should not". A tab keeps its
   * shelf entry wherever it wanders, and the entry shows where it is.
   */
  shelfId?: string;
}

/**
 * How many pages may be AWAKE at once.
 *
 * An awake tab is a live Chromium guest with its own processes — twelve is
 * already a browser's worth of memory inside an app that is also running a
 * fleet of agents. An asleep one is a name, an icon and an address: no guest,
 * no processes, no network.
 *
 * So the cap counts guests, not rows. It used to count rows, and that made the
 * limit fall on the wrong thing entirely — a fleet of agents each keeping one
 * page in its own profile is forty rows and, at any moment, two or three
 * guests. Refusing the fortieth because of memory nobody is spending is a
 * refusal with a false reason in it.
 */
export const MAX_TABS = 12;

/**
 * How many rows the strip will hold at all.
 *
 * Still bounded — an unbounded list is a leak with a nicer name — but bounded
 * by what a list costs rather than by what a browser costs. Sized for the
 * fleet the browser is built for: "if we want ten different agents working
 * on forty-five completely different tabs at the same time".
 */
export const MAX_ROWS = 64;

let seq = 0;

export function newTab(url: string = BLANK, profile = "", shelfId?: string): BrowserTab {
  return {
    id: `t${++seq}-${Math.random().toString(36).slice(2, 8)}`,
    url, title: "", icon: null, loading: false, failed: null,
    canBack: false, canForward: false, profile,
    ...(shelfId ? { shelfId } : null),
  };
}

/** Test seam: the ids embed a counter, and a suite that asserts on them wants
 *  it to start from a known place. */
export function __resetTabIds(): void { seq = 0; }

/** A tab as it comes back from a saved session: everything it can say about
 *  itself without a guest, and asleep until somebody looks at it.
 *
 *  The profile comes back with it. These two features landed in the same hour
 *  and this is where they meet: without it, a tab you opened as Work would
 *  return as Default — same title, same icon, same address, signed in as
 *  somebody else, and nothing on screen to say so. */
export function sleepingTab(url: string, title: string, icon: string | null, profile = ""): BrowserTab {
  return { ...newTab(url, profile), title, icon, asleep: true };
}

/**
 * Open it for real.
 *
 * Returns the same array when there is nothing to do, so selecting an already
 * awake tab does not re-render every guest in the strip.
 */
export function wake(tabs: BrowserTab[], id: string): BrowserTab[] {
  if (!tabs.some((t) => t.id === id && t.asleep)) return tabs;
  return tabs.map((t) => (t.id === id ? { ...t, asleep: false } : t));
}

/**
 * What to call a tab.
 *
 * The page's own title when it has one. Before that — and `about:blank` never
 * gets one — the host, which is what somebody scanning a strip of tabs is
 * actually looking for. "New tab" only when there is genuinely nothing to say.
 */
export function tabLabel(t: BrowserTab): string {
  if (t.title.trim()) return t.title.trim();
  if (!t.url || t.url === BLANK) return "New tab";
  try {
    const u = new URL(t.url);
    return u.host || t.url;
  } catch {
    return t.url;
  }
}

/**
 * Close one, and say which tab should take the focus.
 *
 * The rule is the one every browser uses and nobody notices until it is wrong:
 * focus moves to the tab on the RIGHT, and falls back to the left only at the
 * end of the strip. Moving to index 0, or to the last tab, means closing three
 * tabs in a row throws you somewhere different each time.
 *
 * Closing the last tab leaves one blank tab rather than an empty strip: a
 * browser view with no page in it has nothing to show and no way back.
 */
export function closeTab(tabs: BrowserTab[], id: string): { tabs: BrowserTab[]; activeId: string } {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return { tabs, activeId: tabs[0]?.id ?? "" };
  const rest = tabs.filter((t) => t.id !== id);
  if (!rest.length) {
    // The replacement stays in the profile the closed tab was in: closing your
    // last work tab should not quietly drop you back into the default identity.
    const fresh = newTab(BLANK, tabs[i]!.profile);
    return { tabs: [fresh], activeId: fresh.id };
  }
  const next = rest[Math.min(i, rest.length - 1)]!;
  return { tabs: rest, activeId: next.id };
}

/** Add one after the tab it was opened from — a link opened in a new tab
 *  belongs beside its parent, not at the far end of the strip. */
export function addTab(tabs: BrowserTab[], url: string, afterId?: string, profile?: string, shelfId?: string): { tabs: BrowserTab[]; tab: BrowserTab } | { error: string } {
  if (tabs.length >= MAX_ROWS) {
    return { error: `${MAX_ROWS} pages is the limit. Close one first — or drop a profile you are done with, which closes its pages with it.` };
  }
  /* The memory cap, counted where the memory is. A new tab is born awake, so
     it needs a guest's worth of room; the ones asleep cost nothing and are not
     in this count. */
  if (tabs.filter((t) => !t.asleep).length >= MAX_TABS) {
    return { error: `${MAX_TABS} pages awake at once is the limit — each one is a live browser, and this app is also running your agents. Close one, or let one go to sleep.` };
  }
  // A link opened from a page stays in the profile that page is signed into.
  // Anything else would sign you out mid-flow, which is the one thing profiles
  // must never do by accident.
  const from = afterId ? tabs.find((t) => t.id === afterId) : undefined;
  const tab = newTab(url, profile ?? from?.profile ?? "", shelfId);
  const at = afterId ? tabs.findIndex((t) => t.id === afterId) : -1;
  const next = at < 0 ? [...tabs, tab] : [...tabs.slice(0, at + 1), tab, ...tabs.slice(at + 1)];
  return { tabs: next, tab };
}

/** Fold a change into one tab, leaving the others identical — so React only
 *  re-renders the row that moved. */
export function patchTab(tabs: BrowserTab[], id: string, patch: Partial<BrowserTab>): BrowserTab[] {
  let hit = false;
  const next = tabs.map((t) => {
    if (t.id !== id) return t;
    // Nothing actually changed: hand back the same object so the list is
    // reference-equal and the strip does not repaint on every poll.
    if ((Object.keys(patch) as (keyof BrowserTab)[]).every((k) => t[k] === patch[k])) return t;
    hit = true;
    return { ...t, ...patch };
  });
  return hit ? next : tabs;
}

/** Move by one, wrapping — what Ctrl+Tab does. */
export function stepTab(tabs: BrowserTab[], activeId: string, delta: 1 | -1): string {
  if (tabs.length < 2) return activeId;
  const i = tabs.findIndex((t) => t.id === activeId);
  if (i < 0) return tabs[0]!.id;
  return tabs[(i + delta + tabs.length) % tabs.length]!.id;
}

/**
 * Is this tab a page, or just a place to type?
 *
 * A blank tab holds nothing: no address, no title, no history. It is the state
 * between pressing Ctrl+T and typing something, and the panel already says so
 * in the middle of the screen — "Ctrl+T, or the address on the right, to start
 * browsing". A row for it in the sidebar is the same sentence, said again, in a
 * list of pages you actually have.
 */
export const isBlank = (t: BrowserTab): boolean => (!t.url || t.url === BLANK) && !t.title.trim();

/** The tabs a list should draw. Blank ones are not pages. */
export const listable = (tabs: BrowserTab[]): BrowserTab[] => tabs.filter((t) => !isBlank(t));

/**
 * Blank tabs nobody is on, dropped.
 *
 * They are not drawn (see `listable`), so a blank tab left in the background is
 * a tab with no way back to it — the one shape a list must never leave behind.
 * Nothing is lost: a blank tab has no page in it. The one you are ON survives,
 * because that is where you are about to type.
 */
export function pruneBlank(tabs: BrowserTab[], activeId: string): BrowserTab[] {
  const kept = tabs.filter((t) => !isBlank(t) || t.id === activeId);
  // Never nothing: an empty list has no active tab and nowhere to type.
  return kept.length ? kept : tabs.slice(0, 1);
}
