// What was open in the browser last time, per profile, and what it costs to
// bring back.
//
// Its own module for the same reason browserTabs.ts is: none of this is about
// Electron. It is a shape, a size limit and a couple of rules about what is
// worth remembering — testable without a browser, and out of a component that
// already has plenty to do.
//
// ── A profile is a set of tabs ───────────────────────────────────────────
//
// It started as one strip with a colour dot per tab, which answered "which
// identity is this page signed in as" and nothing else. The question people
// actually have is the other one: a profile is a place you work — a set of
// pages that belong together, kept apart from another set. So the session is
// keyed by profile, switching profile swaps the whole strip, and the profile
// you were last in is where the app opens.
//
// ── Why the tabs come back ASLEEP ────────────────────────────────────────
//
// Every tab in this browser is a live Chromium guest with its own processes.
// Twelve of them is a browser's worth of memory inside an app that is also
// running a fleet of agents, which is why MAX_TABS is twelve in the first
// place. Restoring twelve tabs by MOUNTING twelve guests would turn "reopen
// where I left off" into the slowest and heaviest thing the app does, once per
// launch, mostly for pages you were not going to look at.
//
// So a restored tab is a name, an icon and an address in the strip, and nothing
// else until you select it. That is what every desktop browser does, and it is
// the only version of this feature that is free. Switching profiles gets the
// same treatment for the same reason: the set you switch AWAY from keeps its
// addresses and loses its guests.

import type { BrowserTab } from "./browserTabs.ts";
import { isProfileId } from "./browserProfiles.ts";

export const SESSION_KEY = "agentglass.browser.session";

/** What is worth writing down. Deliberately not the whole tab: `loading`,
 *  `failed`, `canBack` and `canForward` are facts about a guest that no longer
 *  exists, and restoring them would be restoring a lie. */
export interface SavedTab {
  url: string;
  title: string;
  icon: string | null;
}

/** One profile's worth: its pages and which of them was in front. */
export interface SavedSet {
  tabs: SavedTab[];
  /** Index, not id: ids are minted fresh on every launch. */
  active: number;
}

export interface SavedSession {
  /** 2 keyed the sets by profile. A v1 session — one flat list, from the build
   *  that shipped restore before profiles were a place — is read into the
   *  default profile rather than dropped, because those are real tabs somebody
   *  left open. */
  v: 2;
  /** The profile the app should open in. */
  current: string;
  byProfile: Record<string, SavedSet>;
}

/** Same ceiling as the tab strip, per profile. A session written by a build
 *  with a larger cap must not be able to exceed this one's. */
const MAX = 12;

const isHttpish = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * Which tabs are worth bringing back.
 *
 * A blank tab is not a page you were on — it is the absence of one, and
 * restoring three of them is restoring nothing while looking like a bug. And
 * an address that is not http(s) does not come back at all: `file://` would
 * reopen somebody's disk, and anything stranger is not a page this browser put
 * there.
 */
export function worthSaving(tabs: BrowserTab[]): BrowserTab[] {
  return tabs.filter((t) => isHttpish(t.url)).slice(0, MAX);
}

/** One profile's live strip, as it would be written down. Null when there is
 *  nothing in it worth keeping, which is how an emptied profile stops taking up
 *  room in the file. */
export function toSet(tabs: BrowserTab[], activeId: string): SavedSet | null {
  const keep = worthSaving(tabs);
  if (!keep.length) return null;
  // The active index is recomputed against the FILTERED list: the tab you were
  // on may have been a blank one, and pointing past the end of the list is how
  // a restore opens on the wrong page.
  const at = keep.findIndex((t) => t.id === activeId);
  return {
    active: at >= 0 ? at : 0,
    tabs: keep.map((t) => ({ url: t.url, title: t.title, icon: t.icon })),
  };
}

function write(session: SavedSession): void {
  try {
    if (!Object.keys(session.byProfile).length) { localStorage.removeItem(SESSION_KEY); return; }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch { /* private mode, or a quota that a page list should never hit */ }
}

/**
 * Write down one profile's strip, leaving every other profile's alone.
 *
 * Merged rather than replaced, which is the whole point of the shape: the tabs
 * of the profile you are not looking at are not in memory, so a write that
 * rebuilt the file from what is on screen would delete them.
 */
export function saveSession(profileId: string, tabs: BrowserTab[], activeId: string): void {
  const id = isProfileId(profileId) ? profileId : "";
  const prev = readSession();
  const byProfile = { ...(prev?.byProfile ?? {}) };
  const set = toSet(tabs, activeId);
  if (set) byProfile[id] = set;
  else delete byProfile[id];
  write({ v: 2, current: id, byProfile });
}

/** One profile's saved strip, or null. */
export function setFor(session: SavedSession | null, profileId: string): SavedSet | null {
  return session?.byProfile[isProfileId(profileId) ? profileId : ""] ?? null;
}

const cleanSet = (raw: unknown): SavedSet | null => {
  const v = raw as Partial<SavedSet> | undefined;
  if (!v || !Array.isArray(v.tabs)) return null;
  const tabs = v.tabs
    .filter((t): t is SavedTab => !!t && typeof t.url === "string" && isHttpish(t.url))
    .slice(0, MAX)
    .map((t) => ({
      url: t.url,
      title: typeof t.title === "string" ? t.title : "",
      icon: typeof t.icon === "string" ? t.icon : null,
    }));
  if (!tabs.length) return null;
  const active = Number.isInteger(v.active) && v.active! >= 0 && v.active! < tabs.length ? v.active! : 0;
  return { tabs, active };
};

/**
 * Last time's tabs, or null.
 *
 * Everything is re-checked rather than trusted: this is JSON from disk, and a
 * truncated write or a hand-edited value must produce "no session" rather than
 * a crash on the first render of the app. That includes the profile ids, which
 * end up choosing which cookie jar a page loads with — a hand-edited one falls
 * back to the default rather than naming a partition nobody validated.
 */
export function readSession(): SavedSession | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(SESSION_KEY); } catch { return null; }
  if (!raw) return null;
  let v: Record<string, unknown>;
  try { v = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }

  // A v1 session is one flat list with a per-tab profile. Those are real tabs
  // somebody left open, so they are read into the default profile rather than
  // thrown away for having the wrong shape.
  if (v?.v === 1) {
    const set = cleanSet(v);
    return set ? { v: 2, current: "", byProfile: { "": set } } : null;
  }
  if (v?.v !== 2 || !v.byProfile || typeof v.byProfile !== "object") return null;

  const byProfile: Record<string, SavedSet> = {};
  for (const [id, raw2] of Object.entries(v.byProfile as Record<string, unknown>)) {
    if (!isProfileId(id)) continue;
    const set = cleanSet(raw2);
    if (set) byProfile[id] = set;
  }
  if (!Object.keys(byProfile).length) return null;
  const current = typeof v.current === "string" && isProfileId(v.current) ? v.current : "";
  return { v: 2, current, byProfile };
}

/** How many pages a profile is holding, for a menu that has to say what
 *  switching would show you. */
export function countFor(session: SavedSession | null, profileId: string): number {
  return setFor(session, profileId)?.tabs.length ?? 0;
}

export function forgetSession(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* nothing to forget */ }
}

/** Drop one profile's tabs — used when a profile itself is forgotten, so its
 *  strip does not sit in the file waiting for a name that no longer exists. */
export function forgetProfileTabs(profileId: string): void {
  const prev = readSession();
  if (!prev) return;
  const byProfile = { ...prev.byProfile };
  delete byProfile[profileId];
  write({ v: 2, current: prev.current === profileId ? "" : prev.current, byProfile });
}
