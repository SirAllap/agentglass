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
import type { SavedView, ProviderTask, ListStatus, ListField } from "../../shared/providers.ts";

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
  /** When that read happened. Shown as "read N ago" rather than implied. */
  at: number;
  /** The view had more pages than we were willing to follow. */
  truncated?: boolean;
}

interface Store {
  views: SavedView[];
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

export const savedViews = (): SavedView[] => load().views;

/** The stored answer to "may this app change my company's board". */
export const writesAllowed = (): boolean => load().writes === true;
export function setWritesAllowed(on: boolean): void { save({ ...load(), writes: on }); }
export const currentView = (): string | undefined => load().current;

export function setCurrent(id: string): void {
  const s = load();
  if (!s.views.some((v) => v.id === id)) return;
  save({ ...s, current: id });
}

export function addView(v: SavedView): void {
  const s = load();
  // Re-adding an address you already have re-resolves its name rather than
  // making a second identical row.
  const views = [...s.views.filter((x) => x.id !== v.id), v];
  save({ ...s, views, current: v.id });
}

export function removeView(id: string): void {
  const s = load();
  const { [id]: _gone, ...rest } = s.cache;
  const views = s.views.filter((v) => v.id !== id);
  save({
    views, cache: rest,
    current: s.current === id ? views[0]?.id : s.current,
  });
}

export const cachedFor = (id: string): CachedView | undefined => load().cache[id];

export function putCache(entry: CachedView): void {
  const s = load();
  save({ ...s, cache: { ...s.cache, [entry.view.id]: entry } });
}

/** For a test's own teardown. */
export function __clear(): void { cache = { views: [], cache: {} }; }
