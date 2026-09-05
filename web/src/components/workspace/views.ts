import type { ComponentType } from "react";
import type { ViewId } from "../../../../shared/types.ts";
import { GitIcon, DiffIcon, DockerIcon, TerminalIcon, ChatIcon, PrIcon, BrowserIcon, FilesIcon, DashIcon, IssuesIcon, UnderstudyIcon, LanternIcon } from "./icons.tsx";
import { HAS_BROWSER } from "../../lib/desktop.ts";
import { IS_DEMO } from "../../lib/demo.ts";

/** Re-exported from shared so the server (POST /control validation) and the UI
 *  name one set of views. */
export type { ViewId };

export type ViewDef = {
  id: ViewId;
  label: string;
  /** Bare letter that jumps here. Kept identical to the old per-panel hotkeys
   *  so nobody has to relearn them. */
  key: string;
  icon: ComponentType<{ size?: number }>;
  hint: string;
  /**
   * Where this ships in the rail — the default drawer, not a fixed one.
   *
   * "utility" sits at the bottom with settings, ports and resources; everything
   * else is at the top. The line is not importance, it is what you are doing
   * with the window: the top is where you WORK — the tree, the diff, the shell,
   * the containers — and the bottom is what you go and LOOK at. Mixing the two
   * is what made the rail a column of eight things with no shape.
   *
   * Which drawer a view is actually IN is the user's, and lives in the rail
   * layout below; this is only where it starts.
   */
  group?: "utility";
};

/** Order is the rail's order, and ⌘1..⌘N index into it.
 *
 *  Browser is last, and conditional. Appending is the only place it could go
 *  without renumbering chords people already have in their fingers — and it is
 *  dropped entirely outside the desktop shell, where a `<webview>` does not
 *  exist. A rail entry that opens an empty pane on a phone would be worse than
 *  no entry at all.
 *
 *  The demo is the exception, and it is not a phone: it has pages written into
 *  it (see lib/demoBrowser.ts), so the entry opens something. Dropping it there
 *  meant the browser did not exist for anybody evaluating the app from the
 *  landing page, which is a worse outcome than the empty pane this guard is
 *  about. */
export const VIEWS: ViewDef[] = [
  // First, and it leads for a reason: this is the app's own screen — the fleet,
  // the spend, the history — and it used to BE the app. It is a view now, but a
  // view you can always get back to in one key.
  { id: "dash", label: "Dashboard", key: "1", icon: DashIcon, hint: "The fleet, the spend and the history — every panel, unchanged", group: "utility" },
  { id: "git", label: "Git", key: "g", icon: GitIcon, hint: "Stage, commit, push/pull the working tree" },
  { id: "diff", label: "Diff", key: "d", icon: DiffIcon, hint: "Review & commit every diff the fleet made" },
  { id: "pr", label: "Pull requests", key: "p", icon: PrIcon, hint: "Review pull requests without leaving for the browser" },
  { id: "tasks", label: "Tasks", key: "i", icon: IssuesIcon, hint: "Everything you owe — GitHub issues and your own list, in one place" },
  { id: "docker", label: "Docker", key: "o", icon: DockerIcon, hint: "Containers, logs, stats & actions" },
  { id: "term", label: "Term", key: "t", icon: TerminalIcon, hint: "A real shell in any repo/worktree" },
  { id: "chat", label: "Chat", key: "c", icon: ChatIcon, hint: "Drive a Claude session in any repo/worktree", group: "utility" },
  ...(HAS_BROWSER || IS_DEMO
    ? [{ id: "browser" as const, label: "Browser", key: "b", icon: BrowserIcon, hint: "A page, without leaving the app", group: "utility" as const }]
    : []),
  // Appended, for the same reason Browser was: ⌘1..⌘N index into this order,
  // and inserting anywhere above renumbers a chord somebody already has in
  // their fingers. Anyone who has ever dragged the rail gets it appended to
  // their own order regardless — loadViewOrder puts unknown views at the end —
  // so leading with it here would only have renumbered the people who never
  // touched it.
  { id: "files", label: "Files", key: "e", icon: FilesIcon, hint: "Browse and search a checkout — and open a file to edit" },
  // Appended for the same reason Files was — a number already in somebody's
  // fingers is not worth taking away — and it ships in the bottom drawer for
  // the reason set out on `group` above: this is a thing you go and LOOK at.
  // It is a scorecard. It cannot stage, commit, launch or answer anything, and
  // a seat among the views you WORK in would be a promise the view does not
  // keep.
  { id: "understudy", label: "Clone", key: "u", icon: UnderstudyIcon, hint: "What a stand-in would have done, and how often that matched — it never acts", group: "utility" },
  /*
   * Appended, same reason as the two above it. Bottom drawer because it is a
   * thing you go and LOOK at — and the one view whose icon comes to you: it
   * lights with a count when an agent is stopped on you, from wherever you
   * are. It was a tab inside Clone called "Crew", which is where nobody found
   * it and a name that meant nothing: "it makes no sense to me… something outside
   * the clone, since it is not only about the clone".
   */
  { id: "lantern", label: "Lantern", key: "l", icon: LanternIcon, hint: "Who needs you, what every agent is working on, and the way there — it never acts on its own", group: "utility" },
];

export const VIEW_IDS = VIEWS.map((v) => v.id);

/** "g" -> "git". Used by the global keydown handler. */
export const LETTER_TO_VIEW: Record<string, ViewId> = Object.fromEntries(
  VIEWS.map((v) => [v.key, v.id]),
);

export const isViewId = (v: unknown): v is ViewId => VIEW_IDS.includes(v as ViewId);

/** The three places a view can be: the top drawer, the bottom drawer, or gone.
 *
 *  "work" and "utility" are the two clusters the rail draws. "hidden" is not a
 *  cluster — it is the rail's back pocket, and the only thing that reads it is
 *  the restore menu. */
export type RailPlace = "work" | "utility" | "hidden";

export const RAIL_PLACES: RailPlace[] = ["work", "utility", "hidden"];

export type RailLayout = Record<RailPlace, ViewDef[]>;
export type RailIds = Record<RailPlace, ViewId[]>;

export const railIds = (l: RailLayout): RailIds => ({
  work: l.work.map((v) => v.id),
  utility: l.utility.map((v) => v.id),
  hidden: l.hidden.map((v) => v.id),
});

const RAIL_KEY = "agentglass.workspace.rail";
/** Superseded by RAIL_KEY, and read exactly once — when there is no layout yet,
 *  to carry over an order somebody already dragged into shape. Not written any
 *  more: a flat list cannot say which drawer a view sits in. */
const LEGACY_ORDER_KEY = "agentglass.workspace.order";

/** What the rail looks like before anyone touches it. Also the server snapshot
 *  for useSyncExternalStore, where localStorage does not exist. */
export const SHIPPED_RAIL: RailLayout = {
  work: VIEWS.filter((v) => v.group !== "utility"),
  utility: VIEWS.filter((v) => v.group === "utility"),
  hidden: [],
};

/**
 * The rail, as the user arranged it.
 *
 * Shipped order is one opinion about which view you reach for most, and it is
 * wrong for anyone whose day is shaped differently — someone living in the
 * terminal wants it under their thumb, not third from the top, and someone who
 * has never opened Docker wants it gone rather than merely last. Stored as ids
 * per drawer and merged over the shipped list, so a view added in a later
 * version appears rather than being silently dropped by an older saved layout.
 */
/**
 * Cached, and it has to be.
 *
 * This is the getSnapshot for a useSyncExternalStore, which compares snapshots
 * by identity — returning a freshly built object on every call means every
 * render reports a change, which loops until React gives up and renders
 * nothing. A blank workspace, seconds after a drag. The same note is on
 * liveSessionCount for the same reason; it is the standard way to get this
 * wrong.
 */
let cachedRail: RailLayout | null = null;
let cachedWork: ViewId[] | null = null;
let cachedVisible: ViewId[] | null = null;

export function loadRail(): RailLayout {
  if (!cachedRail) cachedRail = buildRail();
  return cachedRail;
}

function buildRail(): RailLayout {
  const byId = new Map(VIEWS.map((v) => [v.id, v]));
  // One claim per view across all three drawers: a layout that listed `term`
  // in both work and hidden would otherwise draw it once and count it twice.
  const taken = new Set<ViewId>();
  const pick = (raw: unknown): ViewDef[] => {
    const out: ViewDef[] = [];
    if (!Array.isArray(raw)) return out;
    for (const id of raw) {
      const v = byId.get(id as ViewId);
      if (v && !taken.has(v.id)) { taken.add(v.id); out.push(v); }
    }
    return out;
  };

  let stored: Partial<Record<RailPlace, unknown>> | null = null;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RAIL_KEY) || "null");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) stored = raw as Partial<Record<RailPlace, unknown>>;
  } catch { /* absent or corrupt */ }

  if (!stored) {
    // No layout yet. An order dragged under the old flat scheme still says
    // something true — which view you reached for first — so keep it, and let
    // each view's shipped group decide the drawer, exactly as the rail used to
    // decide it at render time.
    let legacy: unknown = null;
    try { legacy = JSON.parse(localStorage.getItem(LEGACY_ORDER_KEY) || "null"); } catch { /* absent or corrupt */ }
    const flat = pick(legacy);
    for (const v of VIEWS) if (!taken.has(v.id)) { taken.add(v.id); flat.push(v); }
    return {
      work: flat.filter((v) => v.group !== "utility"),
      utility: flat.filter((v) => v.group === "utility"),
      hidden: [],
    };
  }

  const work = pick(stored.work);
  const utility = pick(stored.utility);
  const hidden = pick(stored.hidden);
  // A view that shipped after this layout was saved lands in its own drawer, at
  // the end — visible, because a view nobody has had the chance to reject
  // should not arrive already hidden.
  for (const v of VIEWS) {
    if (taken.has(v.id)) continue;
    taken.add(v.id);
    (v.group === "utility" ? utility : work).push(v);
  }
  return { work, utility, hidden };
}

export function saveRail(next: RailIds) {
  try { localStorage.setItem(RAIL_KEY, JSON.stringify(next)); } catch { /* non-fatal */ }
  cachedRail = null; // rebuilt on the next read, once, and stable again after
  cachedWork = null;
  cachedVisible = null;
  for (const fn of railListeners) fn();
}

const railListeners = new Set<() => void>();
export function subscribeRail(fn: () => void): () => void {
  railListeners.add(fn);
  return () => { railListeners.delete(fn); };
}

/** Put `id` at `index` of `place`, taking it out of wherever it was. */
export function moveView(id: ViewId, place: RailPlace, index = Number.MAX_SAFE_INTEGER) {
  saveRail(withMove(railIds(loadRail()), id, place, index));
}

/** The same move as a pure function, so a drag can project it repeatedly
 *  without touching storage — nothing is written until the drop. */
export function withMove(base: RailIds, id: ViewId, place: RailPlace, index: number): RailIds {
  const next: RailIds = {
    work: base.work.filter((x) => x !== id),
    utility: base.utility.filter((x) => x !== id),
    hidden: base.hidden.filter((x) => x !== id),
  };
  const list = next[place];
  list.splice(Math.max(0, Math.min(index, list.length)), 0, id);
  return next;
}

export const sameRail = (a: RailIds, b: RailIds) =>
  RAIL_PLACES.every((p) => a[p].length === b[p].length && a[p].every((id, i) => id === b[p][i]));

export function resetRail() {
  try { localStorage.removeItem(RAIL_KEY); localStorage.removeItem(LEGACY_ORDER_KEY); } catch { /* non-fatal */ }
  cachedRail = null;
  cachedWork = null;
  cachedVisible = null;
  for (const fn of railListeners) fn();
}

export const railCustomised = () => !sameRail(railIds(loadRail()), railIds(SHIPPED_RAIL));

/**
 * The top drawer, and the only thing ⌘1..⌘9 index into.
 *
 * The numbers belong to the work drawer alone. Down at the bottom they were
 * numbering the wrong things: the dashboard, a web page and a chat sat among
 * settings and ports, none of which has ever had a number, and a ⌘6 that opens
 * a browser reads as an accident of list position rather than a shortcut
 * anybody chose. Moving a view down there now takes its number away, which is
 * the honest meaning of "this is not where I work".
 */
export function workIds(): ViewId[] {
  if (!cachedWork) cachedWork = loadRail().work.map((v) => v.id);
  return cachedWork;
}

/** Everything the rail actually draws, top drawer then bottom. What ⌘[ / ⌘]
 *  cycles, and what a view has to be in to be worth switching to. */
export function visibleIds(): ViewId[] {
  if (!cachedVisible) {
    const r = loadRail();
    cachedVisible = [...r.work, ...r.utility].map((v) => v.id);
  }
  return cachedVisible;
}

export const isVisibleView = (id: ViewId) => visibleIds().includes(id);

const LAST_VIEW_KEY = "agentglass.workspace.view";

/** The workspace reopens where you left it — switching views is the common
 *  action, so the last one is a far better guess than a fixed default. Unless
 *  it has since been hidden, in which case reopening onto a view the rail no
 *  longer draws would be a workspace with nothing selected. */
export function loadLastView(): ViewId {
  try {
    const v = localStorage.getItem(LAST_VIEW_KEY);
    if (isViewId(v) && isVisibleView(v)) return v;
  } catch { /* private mode / disabled storage */ }
  return isVisibleView("git") ? "git" : (visibleIds()[0] ?? "git");
}

export function saveLastView(v: ViewId) {
  try { localStorage.setItem(LAST_VIEW_KEY, v); } catch { /* non-fatal */ }
}
