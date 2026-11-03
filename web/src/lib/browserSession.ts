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

import { sleepingTab, type BrowserTab } from "./browserTabs.ts";
import { isProfileId } from "./browserProfiles.ts";

export const SESSION_KEY = "agentglass.browser.session";

/** What is worth writing down. Deliberately not the whole tab: `loading`,
 *  `failed`, `canBack` and `canForward` are facts about a guest that no longer
 *  exists, and restoring them would be restoring a lie. */
export interface SavedTab {
  /** The tab's id, so an address an agent wrote down still names the tab after the
   *  strip is rebuilt (a restart, or switching container away and back). */
  id?: string;
  url: string;
  title: string;
  icon: string | null;
  /** The last agent that acted on it, so the overview can still count what an
   *  agent holds after a restart. Who, never what it did. */
  agent?: string;
}

/** One profile's worth: its pages and which of them was in front. */
export interface SavedSet {
  tabs: SavedTab[];
  /** Index, not id: a session written before ids were kept has none. */
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
    tabs: keep.map((t) => ({ id: t.id, url: t.url, title: t.title, icon: t.icon, ...(t.agent ? { agent: t.agent } : null) })),
  };
}

/**
 * Which strip is being written.
 *
 * The browser is mounted twice now — the view, and the tab in the floating
 * bench — and they are two sets of pages, not one: closing a tab in the bench
 * must not close it in the view, and a write that rebuilt the file from what is
 * on screen would do exactly that. A scope is a suffix on the key rather than a
 * second module, so everything else about a session — the shape, the profiles,
 * the migration from v1 — stays written once.
 */
const keyFor = (scope?: string): string => (scope ? `${SESSION_KEY}.${scope}` : SESSION_KEY);

function write(session: SavedSession, scope?: string): void {
  try {
    if (!Object.keys(session.byProfile).length) { localStorage.removeItem(keyFor(scope)); return; }
    localStorage.setItem(keyFor(scope), JSON.stringify(session));
  } catch { /* private mode, or a quota that a page list should never hit */ }
}

/**
 * Write down one profile's strip, leaving every other profile's alone.
 *
 * Merged rather than replaced, which is the whole point of the shape: the tabs
 * of the profile you are not looking at are not in memory, so a write that
 * rebuilt the file from what is on screen would delete them.
 */
export function saveSession(profileId: string, tabs: BrowserTab[], activeId: string, scope?: string): void {
  const cur = isProfileId(profileId) ? profileId : "";
  const prev = readSession(scope);
  const byProfile = { ...(prev?.byProfile ?? {}) };
  /*
   * FILED UNDER THE TAB'S OWN PROFILE, not under whichever one is on screen.
   *
   * This wrote every tab in the strip under the CURRENT profile, and an agent's
   * tab is not in the current profile: `open --as review-pr-540` adds a tab in
   * its own identity to the list that happens to be loaded, deliberately, so
   * that driving the browser never yanks the strip somebody is working in.
   * Saving that list under one id relabelled those tabs, and the next launch
   * restored them as the DEFAULT profile's pages.
   *
   * That is the whole of "the agent ended up in Default without doing anything
   * wrong", and it is worth being precise about the mechanism, because the
   * obvious diagnosis is the wrong one: the profile did not disappear at
   * restart. The tab was filed under the wrong one before the restart, and
   * came back wearing it.
   */
  const groups = new Map<string, BrowserTab[]>();
  for (const t of tabs) {
    const id = isProfileId(t.profile) ? t.profile : "";
    const list = groups.get(id);
    if (list) list.push(t); else groups.set(id, [t]);
  }
  for (const [id, list] of groups) {
    const set = toSet(list, activeId);
    if (set) byProfile[id] = set; else delete byProfile[id];
  }
  /* A profile whose last tab has just been closed keeps no entry: it is not in
     `groups` at all, so the loop above cannot clear it. Only the one being
     written from — another profile's set is somebody else's and stays. */
  if (!groups.has(cur)) delete byProfile[cur];
  /* Nothing open is a fact worth keeping, unlike a blank tab: without the
     marker the next launch finds no file and invents a home-page tab. */
  if (!tabs.length && !Object.keys(byProfile).length) {
    try { localStorage.setItem(keyFor(scope), JSON.stringify({ v: 2, current: cur, byProfile: {} })); } catch { /* as in write */ }
    return;
  }
  write({ v: 2, current: cur, byProfile }, scope);
}

/** One profile's saved strip, or null. */
export function setFor(session: SavedSession | null, profileId: string): SavedSet | null {
  return session?.byProfile[isProfileId(profileId) ? profileId : ""] ?? null;
}

/** The shape `newTab` mints. A hand-edited value is dropped, and so is a repeat. */
const TAB_ID = /^t\d{1,6}-[a-z0-9]{6}$/;
const cleanSet = (raw: unknown): SavedSet | null => {
  const v = raw as Partial<SavedSet> | undefined;
  if (!v || !Array.isArray(v.tabs)) return null;
  const tabs = v.tabs
    .filter((t): t is SavedTab => !!t && typeof t.url === "string" && isHttpish(t.url))
    .slice(0, MAX)
    .map((t) => ({
      ...(typeof t.id === "string" && TAB_ID.test(t.id) ? { id: t.id } : null),
      url: t.url,
      title: typeof t.title === "string" ? t.title : "",
      icon: typeof t.icon === "string" ? t.icon : null,
      ...(typeof t.agent === "string" && t.agent.trim() ? { agent: t.agent.trim().slice(0, 40) } : null),
    }));
  if (!tabs.length) return null;
  const seen = new Set<string>();
  for (const t of tabs) { if (t.id && seen.has(t.id)) delete t.id; else if (t.id) seen.add(t.id); }
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
export function readSession(scope?: string): SavedSession | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(keyFor(scope)); } catch { return null; }
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
  // An empty strip written on purpose (see saveSession) restores as empty; one
  // that only LOOKS empty because every set was garbage is still "no session".
  if (!Object.keys(byProfile).length && Object.keys(v.byProfile as object).length) return null;
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

/** What the browser opens with: the space on screen, every page, and the one in front. */
export interface Opening { profile: string; tabs: BrowserTab[]; activeId: string }

/**
 * Last time's session as the strip the app opens with.
 *
 * `known` is the container list, `home` mints the one fresh tab for a browser
 * with nothing to restore.
 */
export function openingStrip(saved: SavedSession | null, known: ReadonlySet<string>, home: (profile: string) => BrowserTab): Opening {
  /*
   * No session yet — a fresh install, or a profile that has never opened this
   * browser. Asleep like every other restored tab (see below): a real
   * renderer profile with the debug port found a `<webview>` at about:blank
   * on every idle desktop session, and this was why — a live Chromium guest
   * mounted at launch and pointed at the home page, whether or not anybody
   * had looked at the browser view yet. The home page itself normally loads
   * fine; it read as about:blank because the guest that measured it had no
   * network route out.
   */
  if (!saved) { const t = home(""); return { profile: "", tabs: [t], activeId: t.id }; }
  // Everything was closed on purpose last time: restore nothing, invent nothing.
  if (!Object.keys(saved.byProfile).length) return { profile: saved.current, tabs: [], activeId: "" };
  /*
   * A CONTAINER THAT NO LONGER EXISTS BRINGS NOTHING BACK.
   *
   * Dropping a container forgets its pages, and closing its last page takes
   * its entry out — but a file written before either of those existed still
   * holds them, and every launch restored the lot. Measured on the real app:
   * fifty containers that had been dropped hours earlier, sixty-four pages,
   * and `newtab` refusing with "64 pages is the limit" on a browser whose
   * owner had fourteen pages open.
   *
   * The names are the authority, not the tab file: an id that is not in the
   * container list is an identity nothing can reach — no menu, no strip, no
   * `--as`. Restoring pages into it is restoring them nowhere.
   */
  const reachable = (id: string) => !id || known.has(id);
  /*
   * THE SPACE ON SCREEN MAY BE EMPTY.
   *
   * Its last page was closed while another container's stayed open, and the
   * file still names it as where to open. Opening there minted a home page in
   * it: a closed Default came back as "Default · 1 tab" beside the container
   * that was really open. Open in a space that has pages instead.
   */
  const profile = setFor(saved, saved.current) ? saved.current : (Object.keys(saved.byProfile).find(reachable) ?? saved.current);
  const set = setFor(saved, profile);
  // The one in front keeps its remembered name too, and only its `asleep`
  // differs. Built with `newTab` it came back nameless and the strip read
  // "New tab" until the page loaded, which is a flicker on every launch.
  /*
   * Everything asleep, even the one that was in front.
   *
   * This panel is now mounted from launch whether or not anybody goes to it
   * (see KEEP_RUNNING), and waking a tab here would put a Chromium guest in
   * every session that never opens the browser. The one in front wakes the
   * moment the view is looked at — or the moment an agent asks for it, which
   * is the other way this panel comes to life.
   */
  /*
   * EVERY PROFILE'S PAGES COME BACK, not only the one on screen.
   *
   * Restoring the current profile alone was right while a profile was a
   * place a person works in and only one of them existed at a time. It is
   * wrong now that agents each have one: an agent's tabs simply vanished at
   * launch, so restarting the application lost all their work, which was
   * literally true, and the agent's next call found nothing to address and
   * fell through to whatever was in front.
   *
   * It costs nothing. A restored tab is a name, an icon and an address with
   * no guest behind it — that is what `sleepingTab` is — so bringing back
   * forty of them is forty rows in an array. The strip shows the profile you
   * are in; the rest are addressable and invisible, which is exactly what an
   * agent's tab should be.
   */
  const revive = (id: string, s: SavedSet) => s.tabs.map((t) => ({ ...sleepingTab(t.url, t.title, t.icon, id, t.id), ...(t.agent ? { agent: t.agent } : null) }));
  const mine = set ? revive(profile, set) : [];
  const theirs = Object.entries(saved.byProfile)
    .filter(([id]) => id !== profile && reachable(id))
    .flatMap(([id, s]) => revive(id, s));
  const tabs = [...mine, ...theirs];
  /* Every saved page belonged to a container that is gone: nothing is open,
     so one fresh tab, as on a first launch. */
  if (!tabs.length) { const t = home(profile); return { profile, tabs: [t], activeId: t.id }; }
  /* The page that was in front, not the first one. Every restored tab is
     asleep, so the panel's "first awake one" found none and landed on the
     container's first page: the page being read came back asleep behind the
     home page. */
  return { profile, tabs, activeId: mine[set?.active ?? 0]?.id ?? "" };
}
