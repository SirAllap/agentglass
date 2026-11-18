/*
 * The Jira views you work from, and the last thing each of them said.
 *
 * The same two jobs `clickupviews.ts` has in one file, for the same reason: a
 * saved view is useless without somewhere to put what it returned, and a
 * cached page means nothing once its view is gone. Written beside that module
 * and not on top of it: its file, its ids and its callers must not move, and
 * the two differ where it counts. Jira views are kept PER SITE, because a
 * board number means nothing outside the site that issued it, and the cache
 * holds columns where ClickUp's holds list statuses.
 *
 * Kept in `jira-views.json` beside the config, not in the database: a few
 * short strings a person may want to read or edit, plus a cache that is
 * disposable by definition. No secret passes through here. The cache is on
 * disk so a restart opens on what was last seen instead of on a blank panel;
 * stale by a few minutes beats empty.
 *
 * This file imports nothing from `jira.ts` (which imports it, to drop the
 * cache on a disconnect), so it can be read on its own and cannot form a cycle.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { jiraAccount } from "./jiraAccount.ts";
import { ASSIGNED_VIEW_ID, ASSIGNED_VIEW_NAME } from "../../shared/providers.ts";
import type { JiraColumn, ListStatus, ProviderTask, SavedFolder, SavedView } from "../../shared/providers.ts";

const FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "jira-views.json");

/** Test seam, so a suite never reads or writes the developer's own views. */
let override: string | null = null;
export function __setJiraViewsPath(p: string | null): void { override = p; cache = undefined; savedViewsMemo.clear(); }
const path = (): string => override ?? FILE;

export interface CachedJiraView {
  view: SavedView;
  /** What the last successful read returned. */
  tasks: ProviderTask[];
  /** The board's columns; empty for a filter or a search. */
  columns: JiraColumn[];
  statuses?: ListStatus[];
  /** The board a non-board view's `statuses` came from, when one project's answered for all of it. */
  statusBoard?: { id: string; name: string; key: string };
  /** When that read happened. */
  at: number;
  /** The read stopped at the page cap. */
  truncated?: boolean;
  backlogCut?: boolean;
  /** Version of the status rules that wrote this entry; an entry without the current one is not served. */
  sv?: number;
}

/** Bump when the statuses a read carries change meaning: older cached entries then stop painting first. */
export const STATUS_VERSION = 3;

interface SiteStore {
  views: SavedView[];
  /** Projects added whole; their `lists` are the project's boards, kept as of `listsAt`. */
  folders: SavedFolder[];
  /** Keyed by view id. Dropped with the view it belongs to. */
  cache: Record<string, CachedJiraView>;
  /** The one on screen when you last looked. */
  current?: string;
}

interface Store { sites: Record<string, SiteStore> }

let cache: Store | undefined;
/** Bumped on every write, so `savedViews` below knows the store it built its answer from is still the current one. */
let storeVersion = 0;

function load(): Store {
  if (cache) return cache;
  let s: Store = { sites: {} };
  try {
    const p = path();
    const raw = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as Partial<Store> : null;
    if (raw && typeof raw.sites === "object" && raw.sites) s = { sites: raw.sites as Store["sites"] };
  } catch { /* an unreadable file is an empty one */ }
  cache = s;
  return s;
}

function save(s: Store): void {
  cache = s;
  storeVersion++;
  const p = path();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
  } catch {
    // A cache that cannot be written is still a working app: it is only slower.
  }
}

/** One site's slice, always whole: a file written by hand may lack any part. */
function siteOf(site: string): SiteStore {
  const s = load().sites[site];
  return { views: s?.views ?? [], folders: s?.folders ?? [], cache: s?.cache ?? {}, current: s?.current };
}

function put(site: string, next: SiteStore): void {
  save({ sites: { ...load().sites, [site]: next } });
}

/** Pinned, never stored: a stored default is one somebody can end up without. */
const ASSIGNED: SavedView = { id: ASSIGNED_VIEW_ID, name: ASSIGNED_VIEW_NAME, url: "", addedAt: 0, builtin: true };

/** A board's address on any site: the classic one both Cloud and Data Center answer. */
export const boardAddress = (site: string, boardId: string): string =>
  `https://${site}/secure/RapidBoard.jspa?rapidView=${encodeURIComponent(boardId)}`;

/**
 * The views on the bar: the built-in one, the ones somebody pasted, and every
 * board inside every saved folder. Folder boards are synthesised, not stored,
 * which is what makes "add the project" mean what it says: the day it gains a
 * board, the board is on the bar. A board both pasted and inside a saved
 * folder shows once, as the folder's, because that copy keeps up with Jira.
 */
const savedViewsMemo = new Map<string, { ver: number; views: SavedView[] }>();

export function savedViews(site: string): SavedView[] {
  const hit = savedViewsMemo.get(site);
  if (hit && hit.ver === storeVersion) return hit.views;
  const s = siteOf(site);
  const fromFolders = s.folders.flatMap((f) => (f.lists ?? []).map((l): SavedView => ({
    id: `board:${l.id}`,
    name: l.name,
    listId: l.id,
    listName: l.name,
    url: boardAddress(site, l.id),
    addedAt: f.addedAt,
    folderId: f.id,
    folderName: f.name,
    spaceName: f.spaceName,
  })));
  const taken = new Set(fromFolders.map((v) => v.id));
  const views = [ASSIGNED, ...s.views.filter((v) => !taken.has(v.id)), ...fromFolders];
  savedViewsMemo.set(site, { ver: storeVersion, views });
  return views;
}

export const savedFolders = (site: string): SavedFolder[] => siteOf(site).folders;
export const currentView = (site: string): string | undefined => siteOf(site).current;
/**
 * Cached rows are what one token could see, so they are kept per account as well as per site:
 * two accounts on one site (another person, another token) never read each other's rows.
 * The default account's rows keep the bare view id, as they always were.
 */
const SEP = "\u0001";
const slot = (id: string): string => { const a = jiraAccount(); return a ? `${a}${SEP}${id}` : id; };
/** The cached views of the account in force: the id they were put under, and the entry. */
function ownCache(site: string): [string, CachedJiraView][] {
  const a = jiraAccount();
  const own: [string, CachedJiraView][] = [];
  for (const [k, v] of Object.entries(siteOf(site).cache)) {
    if (a ? k.startsWith(a + SEP) : !k.includes(SEP)) own.push([a ? k.slice(a.length + 1) : k, v]);
  }
  return own;
}
export const cachedFor = (site: string, id: string): CachedJiraView | undefined => {
  const c = siteOf(site).cache[slot(id)];
  return c && c.sv === STATUS_VERSION ? c : undefined;
};

export function setCurrent(site: string, id: string): void {
  if (!savedViews(site).some((v) => v.id === id)) return;
  put(site, { ...siteOf(site), current: id });
}

export function addView(site: string, v: SavedView): void {
  const s = siteOf(site);
  // Selecting the built-in one is the whole of "adding" it.
  if (v.id === ASSIGNED_VIEW_ID) { put(site, { ...s, current: v.id }); return; }
  // Adding an address you already have replaces its row; it never doubles it.
  put(site, { ...s, views: [...s.views.filter((x) => x.id !== v.id), v], current: v.id });
}

/** Keep a view without making it the open one (a saved query is not a request to switch boards). */
export function upsertView(site: string, v: SavedView): void {
  if (v.id === ASSIGNED_VIEW_ID) return;
  const s = siteOf(site);
  put(site, { ...s, views: [...s.views.filter((x) => x.id !== v.id), v] });
}

/**
 * Change a stored view in place; false when it is not one of the stored ones (the built-in, a project's board).
 * The kept read of a view whose address changed is dropped, since it answered another search.
 */
export function patchView(site: string, id: string, patch: Partial<Pick<SavedView, "name" | "team" | "tab" | "url">>): SavedView | null {
  const s = siteOf(site);
  const at = s.views.findIndex((v) => v.id === id);
  if (at < 0) return null;
  const next: SavedView = { ...s.views[at]!, ...patch };
  if (patch.team === false) delete next.team;
  if (patch.tab === false) delete next.tab;
  const views = s.views.map((v, i) => (i === at ? next : v));
  const { [id]: kept, ...rest } = s.cache;
  const cacheNext = kept && patch.url === undefined ? { ...rest, [id]: { ...kept, view: next } } : rest;
  put(site, { ...s, views, cache: cacheNext });
  return next;
}

export function removeView(site: string, id: string): void {
  if (id === ASSIGNED_VIEW_ID) return;
  const s = siteOf(site);
  // The view goes from every account's cache, not only the one in force.
  const rest = Object.fromEntries(Object.entries(s.cache).filter(([k]) => k !== id && !k.endsWith(SEP + id)));
  const views = s.views.filter((v) => v.id !== id);
  put(site, { ...s, views, cache: rest, current: s.current === id ? undefined : s.current });
}

/** Add a project, or replace what is known about one already there (how a refresh lands). */
export function addFolder(site: string, f: SavedFolder): void {
  const s = siteOf(site);
  put(site, { ...s, folders: [...s.folders.filter((x) => x.id !== f.id), f] });
}

/** A refresh lands where the folder already sits; a folder that is gone is not brought back. */
export function replaceFolder(site: string, f: SavedFolder): void {
  const s = siteOf(site);
  if (!s.folders.some((x) => x.id === f.id)) return;
  put(site, { ...s, folders: s.folders.map((x) => (x.id === f.id ? f : x)) });
}

/** True for a board that is on the rail only because its project is: it has no row of its own to remove. */
export function isFolderBoard(site: string, id: string): boolean {
  const s = siteOf(site);
  return !s.views.some((v) => v.id === id) && s.folders.some((f) => (f.lists ?? []).some((l) => `board:${l.id}` === id));
}

export function removeFolder(site: string, id: string): void {
  const s = siteOf(site);
  const gone = new Set((s.folders.find((f) => f.id === id)?.lists ?? []).map((l) => `board:${l.id}`));
  // A board pasted by hand and also in this folder stays, with its own page.
  const pasted = new Set(s.views.map((v) => v.id));
  const cacheLeft = Object.fromEntries(Object.entries(s.cache).filter(([k]) => !gone.has(k) || pasted.has(k)));
  put(site, {
    ...s,
    folders: s.folders.filter((f) => f.id !== id),
    cache: cacheLeft,
    current: s.current && gone.has(s.current) && !pasted.has(s.current) ? undefined : s.current,
  });
}

/**
 * Which saved view of this site already holds the card, from the cache alone.
 *
 * The twin of `boardHolding` in clickupviews.ts, for the pull request list: a
 * list of four hundred rows cannot spend a request per row, so a card is
 * drawn only when a view read in the last `freshMs` holds it, and the freshest
 * read wins when two views do. Matched on the key and on the internal id,
 * case aside. A view whose read is older than `freshMs` is "not looked at",
 * which is the whole truth about it.
 */
export function boardHolding(site: string, cardId: string, o: { freshMs?: number } = {}): { viewId: string; task: ProviderTask; at: number } | null {
  const want = cardId.trim().toLowerCase();
  if (!want) return null;
  let best: { viewId: string; task: ProviderTask; at: number } | null = null;
  for (const [viewId, entry] of ownCache(site)) {
    for (const t of entry?.tasks ?? []) {
      if (t.id.toLowerCase() !== want && (t.customId ?? "").toLowerCase() !== want) continue;
      const at = entry.at ?? 0;
      if (!best || at > best.at) best = { viewId, task: t, at };
    }
  }
  if (!best) return null;
  if (o.freshMs && Date.now() - best.at > o.freshMs) return null;
  return best;
}

/** The project keys the cached cards of this site carry: what a branch name can be read against without a request. */
export function knownKeys(site: string): string[] {
  const keys = new Set<string>();
  for (const [, entry] of ownCache(site)) {
    for (const t of entry?.tasks ?? []) {
      const m = /^([A-Z][A-Z0-9_]*)-\d+$/.exec(t.customId ?? "");
      if (m) keys.add(m[1]!);
    }
  }
  return [...keys].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

export function putCache(site: string, id: string, c: CachedJiraView): void {
  const s = siteOf(site);
  put(site, { ...s, cache: { ...s.cache, [slot(id)]: { ...c, sv: STATUS_VERSION } } });
}

/** Every cached row of every site; the addresses and folders stay. A disconnect is not a delete of the address book. */
export function forgetCached(): void {
  const sites: Store["sites"] = {};
  for (const [k, v] of Object.entries(load().sites)) sites[k] = { ...v, cache: {} };
  save({ sites });
}

/** Test seam: forget everything, in memory and on disk. */
export function __clear(): void { save({ sites: {} }); }
