/*
 * The boards you work from, and the last thing each of them said.
 *
 * Two jobs in one file because they share a lifetime: a saved view is useless
 * without somewhere to put what it returned, and a cached page is meaningless
 * once its view is gone.
 *
 * Kept beside the config rather than in the database. Views are a handful of
 * short strings that a person would reasonably want to read, edit or delete
 * with an editor — the same argument `config.json` already makes for itself —
 * and the cache next to them is disposable by definition. Neither is a secret:
 * the token lives in credentials.json and nothing here touches it.
 *
 * The cache is on disk rather than in memory for one reason, and it is the
 * reason the whole feature is worth having: reading a view takes a second and a
 * half, and the app is restarted often. In memory, every restart pays that
 * again and the panel opens empty; on disk, it opens with what you last saw and
 * corrects itself a second later. Stale by a few minutes beats blank.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { ASSIGNED_VIEW_ID, ASSIGNED_VIEW_NAME } from "../../shared/providers.ts";
import type { SavedView, SavedFolder, ProviderTask, ListStatus, ListField, ListPlace } from "../../shared/providers.ts";

const FILE = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "clickup-views.json",
);

/** Test seam, so a suite never reads or writes the developer's own boards. */
let override: string | null = null;
export function __setViewsPath(p: string | null): void { override = p; cache = undefined; }
const path = (): string => override ?? FILE;

export interface CachedView {
  view: SavedView;
  /** What the last successful read returned. */
  tasks: ProviderTask[];
  statuses: ListStatus[];
  fields: ListField[];
  /** Space / Folder / List, kept with the rest of what the list told us so a
   *  restart opens with the breadcrumb already drawn. */
  place?: ListPlace;
  /** When that read happened. Shown as "read N ago" rather than implied. */
  at: number;
  /** The view had more pages than we were willing to follow. */
  truncated?: boolean;
}

interface Store {
  views: SavedView[];
  /** Folders added whole. Their lists are not stored — see SavedFolder. */
  folders?: SavedFolder[];
  /** Whether changes may be sent to ClickUp. Off until somebody says so — see
   *  clickup.ts for why this default is the opposite of the local list's. */
  writes?: boolean;
  /** Keyed by view id. Trimmed with the view it belongs to. */
  cache: Record<string, CachedView>;
  /** The one on screen when you last looked. */
  current?: string;
}

let cache: Store | undefined;

function load(): Store {
  if (cache) return cache;
  try {
    const p = path();
    cache = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Store) : { views: [], cache: {} };
  } catch {
    cache = { views: [], cache: {} };
  }
  cache!.views ??= [];
  cache!.folders ??= [];
  cache!.cache ??= {};
  return cache!;
}

function save(s: Store): void {
  const p = path();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
    cache = s;
  } catch {
    // A cache that cannot be written is still a working app — it just gets
    // slower. Never fatal.
    cache = s;
  }
}

/**
 * The one board nobody has to add, first on the bar.
 *
 * Pinned rather than written to the file on first run, for two reasons: a
 * default that is stored is a default somebody can end up without — deleted
 * once, gone forever, with no way back except knowing an address that does not
 * exist — and a row in a config file implies it can be edited, when there is
 * nothing here to edit. Everything downstream treats it as an ordinary saved
 * view, which is the point: the cache, "which board was I on", and the chip you
 * click all work with no branch.
 */
const ASSIGNED: SavedView = {
  id: ASSIGNED_VIEW_ID, name: ASSIGNED_VIEW_NAME, url: "", addedAt: 0, builtin: true,
};

/**
 * The boards on the bar: the built-in one, the ones somebody pasted, and every
 * list inside every saved folder.
 *
 * The folder lists are synthesised here rather than stored, which is what makes
 * "add the folder" mean what it says — the day a colleague creates a list in it,
 * it is on the bar. Everything downstream (the cache, "which board was I on",
 * the chip you click) works on a `SavedView`, so they are handed the same shape
 * and need no branch of their own.
 *
 * A list that is BOTH inside a saved folder and pasted by hand appears once, as
 * the folder's: same id, and the folder is the one that will keep it up to date.
 */
export function savedViews(): SavedView[] {
  const s = load();
  const fromFolders = (s.folders ?? []).flatMap((f) => (f.lists ?? []).map((l): SavedView => ({
    id: `list:${l.id}`,
    name: l.name,
    listId: l.id,
    listName: l.name,
    url: `https://app.clickup.com/${l.id}/v/l/li/${l.id}`,
    addedAt: f.addedAt,
    folderId: f.id,
    folderName: f.name,
    spaceName: f.spaceName,
  })));
  const taken = new Set(fromFolders.map((v) => v.id));
  /*
   * The same list, added twice, and only one of the two is worth keeping.
   *
   * Somebody who pastes a list's address and later adds the folder it lives in
   * gets it twice — once as their own row, once as the folder's — and it looks
   * exactly like a bug because it is one. The folder's copy wins: it is the one
   * that keeps up with ClickUp.
   *
   * A saved ClickUp VIEW over that list is not the same thing, though, and this
   * is where a blunter rule would delete somebody's work: `Eng list by start
   * date view` is a filter and an order somebody set up, over a list a folder
   * happens to hold. So the test is whether the pasted row is the LIST itself,
   * which is exactly the case where its name is the list's name.
   */
  const covered = new Set(fromFolders.map((v) => v.listId).filter(Boolean) as string[]);
  /* A pasted list knows where it lives too — the breadcrumb was read the first
     time it was opened and kept with its cached page. Filling it in here is
     what lets the sidebar file "Orbit v2 – Phase 1" under the folder it is
     actually in without anybody adding that folder. Absent until the board has
     been read once, which is honest: we do not know yet. */
  const pasted = s.views.filter((v) => {
    if (taken.has(v.id)) return false;
    if (!v.listId || !covered.has(v.listId)) return true;
    return (v.name || "").trim() !== (v.listName || "").trim();
  }).map((v) => {
    const place = s.cache[v.id]?.place;
    return place && (place.folder || place.space)
      ? { ...v, folderName: v.folderName ?? place.folder, spaceName: v.spaceName ?? place.space }
      : v;
  });
  return [ASSIGNED, ...pasted, ...fromFolders];
}

export const savedFolders = (): SavedFolder[] => load().folders ?? [];

/** Add one, or replace what is known about one already there. The lists that
 *  come with it are a cache — see SavedFolder — so re-adding is also how a
 *  refresh lands. */
export function addFolder(f: SavedFolder): void {
  const s = load();
  const folders = [...(s.folders ?? []).filter((x) => x.id !== f.id), f];
  save({ ...s, folders });
}

export function removeFolder(id: string): void {
  const s = load();
  const gone = new Set(((s.folders ?? []).find((f) => f.id === id)?.lists ?? []).map((l) => `list:${l.id}`));
  const folders = (s.folders ?? []).filter((f) => f.id !== id);
  // Their cached pages go with them: a page is meaningless once its board is
  // gone, which is the rule `removeView` already follows.
  const cacheLeft = Object.fromEntries(Object.entries(s.cache).filter(([k]) => !gone.has(k)));
  save({
    ...s, folders, cache: cacheLeft,
    current: s.current && gone.has(s.current) ? undefined : s.current,
  });
}

/** The stored answer to "may this app change my company's board". */
export const writesAllowed = (): boolean => load().writes === true;
export function setWritesAllowed(on: boolean): void { save({ ...load(), writes: on }); }
export const currentView = (): string | undefined => load().current;

export function setCurrent(id: string): void {
  const s = load();
  if (!savedViews().some((v) => v.id === id)) return;
  save({ ...s, current: id });
}

export function addView(v: SavedView): void {
  const s = load();
  // The built-in one is never stored — selecting it is the whole of "adding" it.
  if (v.id === ASSIGNED_VIEW_ID) { save({ ...s, current: v.id }); return; }
  // Re-adding an address you already have re-resolves its name rather than
  // making a second identical row.
  const views = [...s.views.filter((x) => x.id !== v.id), v];
  save({ ...s, views, current: v.id });
}

export function removeView(id: string): void {
  // Nothing to remove, and nothing to leave a dangling `current` pointing at.
  if (id === ASSIGNED_VIEW_ID) return;
  const s = load();
  const { [id]: _gone, ...rest } = s.cache;
  const views = s.views.filter((v) => v.id !== id);
  save({
    views, cache: rest,
    current: s.current === id ? views[0]?.id : s.current,
  });
}

export const cachedFor = (id: string): CachedView | undefined => load().cache[id];

/**
 * What this workspace's card ids look like — `ORBIT-`, hyphen included.
 *
 * Derived from cards already read rather than configured. The ids are a prefix
 * and a number, the prefix is the same for every card in a workspace, and we
 * are holding dozens of them: so nobody has to be asked what their prefix is,
 * or told they got it wrong.
 *
 * Empty when nothing has been read yet — a fresh machine, or a restart before
 * the first board loads. That is a real state and callers have to treat it as
 * "unknown", never as "no prefix": the difference is between not knowing
 * whether `ABC-12` is one of ours and being sure it is not.
 */
export function knownCardPrefix(): string {
  const s = load();
  // `savedViews()`, not `s.views`: the built-in board is not in the stored list
  // and is cached like any other, so reading the raw store answers "unknown" on
  // a machine whose only board is that one.
  const seen = savedViews().map((v) => s.cache[v.id]?.tasks?.[0]?.customId ?? "").find(Boolean) ?? "";
  return seen.replace(/[0-9]+$/, "");
}

/**
 * Which saved board already holds this card, if any — from the cache alone.
 *
 * Asked before a card fetched by id is shown as a stray. "This card is on a
 * board you have open" and "this card lives somewhere else entirely" deserve
 * different answers, and the second one is only honest when the first has been
 * ruled out.
 *
 * Cache-only, deliberately: this runs on every lookup, and going to ClickUp to
 * ask a question the last read already answered would spend the rate budget on
 * something nobody asked for. A board whose cache is cold answers "no" — which
 * is why the caller must treat this as "not that I know of" rather than "not on
 * any board", and it self-corrects the moment that board is opened.
 *
 * Matched on both ids, because the two halves of the app hold different ones:
 * a pull request carries `ORBIT-1042`, the board's rows carry `86dyn…`.
 */
export function boardHolding(cardId: string): { viewId: string; task: ProviderTask } | null {
  const want = cardId.trim().toLowerCase();
  if (!want) return null;
  const s = load();
  // Every board you HAVE, which is not the same as every board stored: the
  // built-in "assigned to me" is synthesised rather than saved, and it is the
  // one most likely to be holding the card — it is a whole workspace's worth.
  for (const v of savedViews()) {
    for (const t of s.cache[v.id]?.tasks ?? []) {
      if (t.id.toLowerCase() === want || (t.customId ?? "").toLowerCase() === want) return { viewId: v.id, task: t };
    }
  }
  return null;
}

export function putCache(entry: CachedView): void {
  const s = load();
  save({ ...s, cache: { ...s.cache, [entry.view.id]: entry } });
}

/** For a test's own teardown. */
export function __clear(): void { cache = { views: [], cache: {} }; }
