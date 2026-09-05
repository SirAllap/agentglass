/**
 * Somebody's Zen sidebar, read.
 *
 * Zen is a fork of Firefox and keeps its whole sidebar in one file next to the
 * profile: `zen-sessions.jsonlz4` — spaces, folders, and every pinned tab, in
 * mozLz4 (see mozlz4.ts). Measured on a real profile before a line of this was
 * written: 1 space, 14 folders of which 7 are nested, 91 pinned tabs and 11
 * essentials, which is exactly what was on the screen at the time.
 *
 * The one link that is not obvious: a tab does NOT name its folder. It carries
 * a `groupId`, Firefox's tab-group id — and Zen's folder ids ARE its group ids,
 * one for one. That is the join, and without it the import is a flat list.
 *
 * Read-only, and in the one-shot sidecar rather than on an HTTP route, for the
 * same reason the cookies and the history are: this is somebody's browsing,
 * and a route would put it where an agent driving the browser could ask for it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mozLz4Json } from "./mozlz4.ts";

/** One kept page, as this app's shelf wants it. */
export interface ZenItem {
  url: string;
  title: string;
  icon: string | null;
  /** The folder it is in — a Zen folder id — or null for a pin with no folder. */
  folder: string | null;
  /** The space it belongs to, by Zen's own uuid. */
  space: string;
  /** In the grid at the top: visible in every space. */
  essential: boolean;
}

export interface ZenFolder {
  id: string;
  name: string;
  parent: string | null;
  space: string;
  collapsed: boolean;
}

export interface ZenSpace { id: string; name: string }

export interface ZenShelf {
  spaces: ZenSpace[];
  folders: ZenFolder[];
  items: ZenItem[];
}

/* What the file holds, narrowed to the fields this reads. Everything else in
   there is Zen's business — split views, glances, live folders — and is left
   alone rather than half-understood. */
interface RawTab {
  entries?: { url?: string; title?: string }[];
  index?: number;
  pinned?: boolean;
  groupId?: string;
  image?: string | null;
  zenEssential?: boolean;
  zenWorkspace?: string;
  zenPinnedIcon?: string;
  zenStaticLabel?: string;
}
interface RawFolder { id?: string; name?: string; parentId?: string | null; workspaceId?: string; collapsed?: boolean }
interface RawSpace { uuid?: string; name?: string }
interface RawSessions { tabs?: RawTab[]; folders?: RawFolder[]; spaces?: RawSpace[] }

const http = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);

/**
 * The page a tab is showing.
 *
 * `entries` is its history, oldest first, and `index` is 1-BASED — a session
 * store thing that trips everybody. The last entry is where the tab actually
 * is, which is what a pin means; `about:` and friends are dropped, because a
 * kept page you cannot open is a row that only ever disappoints.
 */
function pageOf(t: RawTab): { url: string; title: string } | null {
  const entries = t.entries ?? [];
  if (!entries.length) return null;
  const at = typeof t.index === "number" ? Math.min(entries.length, Math.max(1, t.index)) - 1 : entries.length - 1;
  const e = entries[at] ?? entries[entries.length - 1]!;
  if (!http(e.url)) return null;
  return { url: e.url, title: (t.zenStaticLabel || e.title || "").slice(0, 200) };
}

/**
 * The whole sidebar, from the parsed file.
 *
 * Pure, so the mapping is testable without a profile on the disk — which
 * matters here more than usual, because the only real input is one person's
 * private browser and a fixture of it is not something to keep in a repo.
 */
export function mapZenSessions(raw: RawSessions): ZenShelf {
  const spaces: ZenSpace[] = (raw.spaces ?? [])
    .filter((s) => typeof s.uuid === "string")
    .map((s) => ({ id: s.uuid!, name: (s.name || "Space").slice(0, 40) }));

  const folders: ZenFolder[] = (raw.folders ?? [])
    .filter((f) => typeof f.id === "string")
    .map((f) => ({
      id: f.id!,
      name: (f.name || "Folder").slice(0, 40),
      parent: typeof f.parentId === "string" && f.parentId ? f.parentId : null,
      space: typeof f.workspaceId === "string" ? f.workspaceId : "",
      collapsed: f.collapsed === true,
    }));
  const known = new Set(folders.map((f) => f.id));

  const items: ZenItem[] = [];
  for (const t of raw.tabs ?? []) {
    // Only what was KEPT. The rest of the session is tabs somebody had open at
    // the time, and importing ninety of those would be importing a mess.
    if (!t.pinned && !t.zenEssential) continue;
    const page = pageOf(t);
    if (!page) continue;
    const folder = typeof t.groupId === "string" && known.has(t.groupId) ? t.groupId : null;
    items.push({
      ...page,
      // The pinned icon first: it is the one Zen shows, and for a page that has
      // never been loaded in this app it is the only one there is.
      icon: t.zenPinnedIcon || t.image || null,
      folder,
      space: typeof t.zenWorkspace === "string" ? t.zenWorkspace : "",
      essential: t.zenEssential === true,
    });
  }
  return { spaces, folders, items };
}

/** …and from the profile directory the cookie reader already found. */
export function readZenShelf(dir: string): ZenShelf {
  const file = readFileSync(join(dir, "zen-sessions.jsonlz4"));
  return mapZenSessions(mozLz4Json<RawSessions>(new Uint8Array(file)));
}
