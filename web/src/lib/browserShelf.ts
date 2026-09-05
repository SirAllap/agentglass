// What the browser keeps between sessions: the shelf.
//
// A tab is what you opened today; the shelf is what you keep. Three levels,
// which are the ones Zen settled on and the ones the mockup was drawn from:
//
//   ESSENTIALS  a small grid at the top, the same in every space. The six or
//               eight sites of every day. Closing one does not close it — it
//               goes back to the address it was saved with.
//   FOLDERS     pinned pages, of THIS space, grouped and named by you. They
//               fold away, they nest, and a folded one still says how many it
//               holds.
//   LOOSE PINS  the same thing without a folder, because forcing a folder on a
//               single kept page is bookkeeping nobody asked for.
//
// The tabs of the session are not here. They live in browserSession.ts, they
// come back asleep, and the difference is the whole point: a shelf entry is an
// address you decided to keep, not a page that happened to be open when you
// quit.
//
// Pure and storage-agnostic apart from the two read/write functions at the end,
// so every rule below is testable without a browser — which matters more here
// than usual, because a bug in a move or a delete loses somebody's arrangement
// and there is no undo for it.

export interface ShelfItem {
  /** Stable across sessions: it is what a drag names and what a `<webview>`
   *  keyed by it must not lose. */
  id: string;
  url: string;
  /** What to draw. A kept page has a name from the day it was kept, so the
   *  shelf reads even before anything is loaded. */
  title: string;
  icon: string | null;
}

export interface ShelfFolder {
  id: string;
  name: string;
  /** Folded or not, remembered. A folder you closed is a decision. */
  open: boolean;
  items: ShelfItem[];
  /** Folders inside folders. Bounded by MAX_DEPTH rather than by the type,
   *  because the type would have to lie about the recursion anyway. */
  folders: ShelfFolder[];
}

export interface Shelf {
  essentials: ShelfItem[];
  folders: ShelfFolder[];
  loose: ShelfItem[];
}

/** Twelve, the number Zen uses. Past that the grid stops being something you
 *  read at a glance and becomes a list drawn as squares. */
export const MAX_ESSENTIALS = 12;

/**
 * How deep folders may nest.
 *
 * Three, not five. Every level costs indent out of a 228px column, and the
 * fourth one is where the name stops fitting — a limit taken from what the
 * shelf can DRAW rather than from what a tree can hold.
 */
export const MAX_DEPTH = 3;

export const emptyShelf = (): Shelf => ({ essentials: [], folders: [], loose: [] });

let seq = 0;
const mint = (kind: string): string => `${kind}${++seq}-${Math.random().toString(36).slice(2, 8)}`;
/** Test seam: ids embed a counter and a suite that asserts on them wants it to
 *  start from a known place. */
export function __resetShelfIds(): void { seq = 0; }

export function shelfItem(url: string, title = "", icon: string | null = null): ShelfItem {
  return { id: mint("s"), url, title, icon };
}

export function shelfFolder(name: string): ShelfFolder {
  return { id: mint("f"), name, open: true, items: [], folders: [] };
}

/* ------------------------------------------------------------------ reading */

/** Every folder in the tree, parents before children. */
export function allFolders(shelf: Shelf): ShelfFolder[] {
  const out: ShelfFolder[] = [];
  const walk = (fs: ShelfFolder[]) => { for (const f of fs) { out.push(f); walk(f.folders); } };
  walk(shelf.folders);
  return out;
}

/** Every kept page, essentials included. Used to answer "is this already on the
 *  shelf" without four separate searches. */
export function allItems(shelf: Shelf): ShelfItem[] {
  return [...shelf.essentials, ...shelf.loose, ...allFolders(shelf).flatMap((f) => f.items)];
}

/** How many pages a folder holds, its sub-folders included — what the count
 *  beside a folded folder means. Folded, "3" that ignores the twelve inside its
 *  children would be a number that says the opposite of the truth. */
export function folderCount(f: ShelfFolder): number {
  return f.items.length + f.folders.reduce((n, k) => n + folderCount(k), 0);
}

/** Same address, ignoring a trailing slash and the fragment — the two ways the
 *  same page arrives from a history row and from a live guest. */
export function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
  return !!a && norm(a) === norm(b);
}

export function findByUrl(shelf: Shelf, url: string): ShelfItem | null {
  return allItems(shelf).find((i) => sameUrl(i.url, url)) ?? null;
}

/* ------------------------------------------------------------------ writing */

/** Rebuild the tree with one folder replaced. Everything below edits through
 *  this, so no operation can accidentally drop a branch it was not looking at. */
function mapFolders(folders: ShelfFolder[], id: string, fn: (f: ShelfFolder) => ShelfFolder | null): ShelfFolder[] {
  const out: ShelfFolder[] = [];
  for (const f of folders) {
    if (f.id === id) {
      const next = fn(f);
      if (next) out.push(next);
      continue;
    }
    out.push({ ...f, folders: mapFolders(f.folders, id, fn) });
  }
  return out;
}

export function toggleFolder(shelf: Shelf, id: string): Shelf {
  return { ...shelf, folders: mapFolders(shelf.folders, id, (f) => ({ ...f, open: !f.open })) };
}

/**
 * Point a kept page somewhere else, without losing where it sits.
 *
 * The way a shortcut goes stale: the page you keep is three clicks deep, the
 * site moves it, and re-keeping means dragging a new entry back into the right
 * folder in the right place. This changes the address and nothing else — the
 * folder, the order, the name if it had one of its own.
 *
 * The title follows the new page unless somebody had renamed the entry, which
 * is the one thing an address change must not throw away.
 */
export function retarget(shelf: Shelf, id: string, url: string, title?: string, icon?: string | null): Shelf {
  const clean = url.trim();
  if (!clean) return shelf;
  const was = allItems(shelf).find((i) => i.id === id);
  const renamed = !!was && !!was.title && was.title !== was.url && !!title && was.title !== title;
  const patch = (i: ShelfItem): ShelfItem => (i.id === id
    ? { ...i, url: clean, ...(renamed ? null : { title: title ?? i.title }), ...(icon !== undefined ? { icon: icon ?? undefined } : null) }
    : i);
  const walk = (folders: ShelfFolder[]): ShelfFolder[] =>
    folders.map((f) => ({ ...f, items: f.items.map(patch), folders: walk(f.folders ?? []) }));
  return {
    ...shelf,
    essentials: shelf.essentials.map(patch),
    loose: shelf.loose.map(patch),
    folders: walk(shelf.folders),
  };
}

export function renameFolder(shelf: Shelf, id: string, name: string): Shelf {
  const clean = name.trim().slice(0, 40);
  if (!clean) return shelf;
  return { ...shelf, folders: mapFolders(shelf.folders, id, (f) => ({ ...f, name: clean })) };
}

/**
 * Delete a folder, keeping what was in it.
 *
 * The pages come out to the loose pins rather than going with it. A folder is a
 * label somebody put on a group; deleting the label is not a decision to throw
 * the group away, and there is no undo here to lean on.
 */
export function removeFolder(shelf: Shelf, id: string): Shelf {
  let rescued: ShelfItem[] = [];
  const folders = mapFolders(shelf.folders, id, (f) => {
    rescued = [...f.items, ...f.folders.flatMap((k) => k.items)];
    return null;
  });
  return { ...shelf, folders, loose: [...shelf.loose, ...rescued] };
}

/**
 * Put a folder that has already been minted into the tree.
 *
 * Separate from `addFolder` for one reason: a new folder opens with its name
 * selected, and the caller cannot select what it cannot name. Minting outside
 * means the id is known before the tree is rebuilt.
 */
export function insertFolder(shelf: Shelf, folder: ShelfFolder, parentId?: string | null): Shelf {
  if (!parentId) return { ...shelf, folders: [...shelf.folders, folder] };
  return { ...shelf, folders: mapFolders(shelf.folders, parentId, (p) => ({ ...p, folders: [...p.folders, folder], open: true })) };
}

export function addFolder(shelf: Shelf, name: string, parentId?: string | null): Shelf {
  return insertFolder(shelf, shelfFolder(name.trim() || "Folder"), parentId);
}

/** Take a page off the shelf wherever it is — essentials, a folder, the loose
 *  pins. One function, because "unpin" from a menu cannot know which. */
export function removeItem(shelf: Shelf, itemId: string): Shelf {
  const strip = (fs: ShelfFolder[]): ShelfFolder[] =>
    fs.map((f) => ({ ...f, items: f.items.filter((i) => i.id !== itemId), folders: strip(f.folders) }));
  return {
    essentials: shelf.essentials.filter((i) => i.id !== itemId),
    loose: shelf.loose.filter((i) => i.id !== itemId),
    folders: strip(shelf.folders),
  };
}

/**
 * Where a page is going. `null` folder means the loose pins; `essentials` is
 * its own place because it is capped and shared across spaces.
 */
export type ShelfSpot = { to: "essentials" } | { to: "loose" } | { to: "folder"; id: string };

/**
 * Put a page somewhere on the shelf, taking it out of wherever it was.
 *
 * One move rather than a remove and an add: the two-step version is what loses
 * an item when the destination refuses it — which the essentials grid does, at
 * twelve.
 */
export function place(shelf: Shelf, item: ShelfItem, spot: ShelfSpot, index?: number): Shelf {
  if (spot.to === "essentials" && shelf.essentials.length >= MAX_ESSENTIALS
      && !shelf.essentials.some((i) => i.id === item.id)) {
    return shelf;
  }
  const without = removeItem(shelf, item.id);
  const at = (list: ShelfItem[]): ShelfItem[] => {
    const n = index == null ? list.length : Math.max(0, Math.min(list.length, index));
    return [...list.slice(0, n), item, ...list.slice(n)];
  };
  if (spot.to === "essentials") return { ...without, essentials: at(without.essentials) };
  if (spot.to === "loose") return { ...without, loose: at(without.loose) };
  return {
    ...without,
    folders: mapFolders(without.folders, spot.id, (f) => ({ ...f, items: at(f.items), open: true })),
  };
}

/** Is this folder allowed to hold another folder? Depth is counted from the
 *  top, and the check belongs here rather than in the menu that offers it. */
export function canNest(shelf: Shelf, folderId: string): boolean {
  /* `level` rather than `d`, and the parameter name matters: the TDZ lock reads
     a name used above its own `const` as the bug it was written for (see
     web/test/hook-tdz.test.ts), and a shadowed one-letter parameter is exactly
     the shape it cannot tell apart from the real thing. */
  const levelOf = (fs: ShelfFolder[], id: string, level = 1): number => {
    for (const f of fs) {
      if (f.id === id) return level;
      const inner = levelOf(f.folders, id, level + 1);
      if (inner) return inner;
    }
    return 0;
  };
  const found = levelOf(shelf.folders, folderId);
  return found > 0 && found < MAX_DEPTH;
}

/* --------------------------------------------------------------- persistence */

export const SHELF_KEY = "agentglass.browser.shelf";

/** One blob for every space, because they are written together and a key per
 *  space is a key per space to migrate later. */
export type Shelves = Record<string, Shelf>;

const clean = (raw: unknown): Shelf => {
  const r = (raw ?? {}) as Partial<Shelf>;
  const item = (x: unknown): ShelfItem | null => {
    const i = (x ?? {}) as Partial<ShelfItem>;
    if (typeof i.url !== "string" || !i.url) return null;
    return { id: typeof i.id === "string" && i.id ? i.id : mint("s"), url: i.url, title: String(i.title ?? ""), icon: typeof i.icon === "string" ? i.icon : null };
  };
  const items = (x: unknown): ShelfItem[] => (Array.isArray(x) ? x.map(item).filter((i): i is ShelfItem => !!i) : []);
  const folders = (x: unknown, depth = 1): ShelfFolder[] => (Array.isArray(x) ? x.map((y) => {
    const f = (y ?? {}) as Partial<ShelfFolder>;
    return {
      id: typeof f.id === "string" && f.id ? f.id : mint("f"),
      name: String(f.name ?? "Folder").slice(0, 40),
      open: f.open !== false,
      items: items(f.items),
      folders: depth < MAX_DEPTH ? folders(f.folders, depth + 1) : [],
    };
  }) : []);
  return {
    essentials: items(r.essentials).slice(0, MAX_ESSENTIALS),
    loose: items(r.loose),
    folders: folders(r.folders),
  };
};

/**
 * Read every space's shelf.
 *
 * Rebuilt field by field rather than trusted: this is JSON from disk, it is
 * read on every launch, and one hand-edited file should not be able to put a
 * folder six deep or an item with no address into the tree.
 */
export function readShelves(): Shelves {
  try {
    const raw = JSON.parse(localStorage.getItem(SHELF_KEY) || "{}") as Record<string, unknown>;
    const out: Shelves = {};
    for (const [id, v] of Object.entries(raw ?? {})) out[id] = clean(v);
    return out;
  } catch { return {}; }
}

export function saveShelves(all: Shelves): void {
  try { localStorage.setItem(SHELF_KEY, JSON.stringify(all)); }
  catch { /* private mode, a full disk — losing an arrangement is not worth throwing over */ }
}

/**
 * One space's shelf, with the essentials shared.
 *
 * Essentials live in the DEFAULT space's record and every space reads them from
 * there. That is what "the same in every space" means, and keeping one copy is
 * what stops the sixth space having a stale set nobody remembers editing.
 */
export function shelfFor(all: Shelves, spaceId: string): Shelf {
  const mine = all[spaceId] ?? emptyShelf();
  return { ...mine, essentials: (all[""] ?? emptyShelf()).essentials };
}

export function withShelf(all: Shelves, spaceId: string, shelf: Shelf): Shelves {
  const next: Shelves = { ...all, [spaceId]: { ...shelf, essentials: [] } };
  next[""] = { ...(next[""] ?? emptyShelf()), essentials: shelf.essentials };
  return next;
}

/* ------------------------------------------------------------- importing */

/**
 * A sidebar read out of another browser.
 *
 * Structurally what the shell hands back from the one-shot that reads the
 * profile (server/src/zenshelf.ts). Declared again here rather than imported
 * across the boundary: the two halves are built separately, and a type shared
 * by reaching into the server's source is a coupling that outlives the reason
 * for it.
 */
export interface ImportedShelf {
  spaces: { id: string; name: string }[];
  folders: { id: string; name: string; parent: string | null; space: string; collapsed: boolean }[];
  items: { url: string; title: string; icon: string | null; folder: string | null; space: string; essential: boolean }[];
}

/**
 * Fold an imported sidebar into this one.
 *
 * Adds; never replaces. Somebody who imports twice, or who imports after
 * arranging a few things by hand, keeps what they had — the shelf is arranged
 * by hand and there is no undo, so an import that overwrote it would be the
 * most expensive button in the app.
 *
 * `space` picks which of the other browser's spaces to take. Its folders and
 * pins are the ones with that space's id; its ESSENTIALS are taken whatever
 * space they came from, because that is what an essential is over there too.
 */
export interface ImportResult {
  shelf: Shelf;
  /** Pages that landed. */
  added: number;
  /**
   * Pages this shelf already had, left exactly where they were.
   *
   * Reported rather than swallowed, because the silence is what made the import
   * read as broken: four pages he had already kept by hand were skipped
   * correctly, stayed in HIS folder, and the imported folder came up short with
   * nothing on screen to say why.
   */
  already: number;
}

export function mergeImported(shelf: Shelf, imported: ImportedShelf, space?: string): ImportResult {
  const want = space ?? imported.spaces[0]?.id ?? "";
  let out = shelf;

  /* Parents before children, so a folder always has somewhere to be put. A
     nested folder whose parent has not been created yet would otherwise land at
     the top level and take its pages with it. */
  const mapped = new Map<string, string>();
  const pending = imported.folders.filter((f) => !f.space || f.space === want);
  let guard = pending.length + 1;
  while (pending.length && guard-- > 0) {
    for (const f of [...pending]) {
      if (f.parent && !mapped.has(f.parent)) continue;
      const made = shelfFolder(f.name);
      out = insertFolder(out, made, f.parent ? mapped.get(f.parent) : null);
      mapped.set(f.id, made.id);
      pending.splice(pending.indexOf(f), 1);
    }
  }

  let added = 0;
  let already = 0;
  for (const it of imported.items) {
    if (!it.essential && it.space && it.space !== want) continue;
    // Already kept, by hand or by an earlier import. Left exactly where it is.
    if (findByUrl(out, it.url)) { already++; continue; }
    added++;
    const item = shelfItem(it.url, it.title, it.icon);
    if (it.essential && out.essentials.length < MAX_ESSENTIALS) { out = place(out, item, { to: "essentials" }); continue; }
    const folder = it.folder ? mapped.get(it.folder) : undefined;
    // An essential past the twelfth is kept rather than dropped: it was one of
    // the pages somebody cared most about.
    out = place(out, item, folder ? { to: "folder", id: folder } : { to: "loose" });
  }

  /* Folded LAST. Putting a page in a folder opens it — deliberately, so a drop
     never makes something disappear — and doing that while filling the tree
     would arrive with every folder open, which for fourteen of them is a wall
     of ninety rows. */
  for (const f of imported.folders) {
    const id = f.collapsed ? mapped.get(f.id) : null;
    if (id) out = toggleFolder(out, id);
  }
  return { shelf: out, added, already };
}

/* ------------------------------------------------- shelf and tabs, bound --- */

/**
 * Which kept page a tab IS, if any.
 *
 * By identity first and by address second. The address alone was the whole bug:
 * a kept page opened, you pressed a link inside it, and the tab stopped
 * matching its own shelf entry — so the entry went dark and the tab appeared in
 * the loose list underneath, which looks exactly like the browser having opened
 * a second tab. A kept page is a page you keep; where it has wandered to is not
 * a different tab.
 *
 * The address is still consulted for the tab that was opened some other way and
 * happens to be on a kept page — typing the url, following a link to it — so
 * that page is not drawn twice.
 */
export function boundItem<T extends { shelfId?: string; url: string }>(tab: T, shelf: Shelf): ShelfItem | null {
  /* An empty string is "this one was deliberately un-kept": pressing the × on a
     shelf row takes the entry away and leaves the page open as an ordinary tab,
     and without this it would be adopted straight back by any other entry that
     happens to hold the same address — which is common, because the shelf is
     full of pages from one site. `undefined` is the ordinary "never was kept". */
  if (tab.shelfId === "") return null;
  if (tab.shelfId) {
    const byId = allItems(shelf).find((i) => i.id === tab.shelfId);
    // A shelf entry can be deleted while its tab is open. The tab survives it
    // and becomes an ordinary one rather than pointing at nothing.
    if (byId) return byId;
  }
  return findByUrl(shelf, tab.url) ?? null;
}

/** The tabs the session list draws: the ones that are not a kept page. A page
 *  kept AND listed again is the same page twice, and the place it is drawn is
 *  the place that says what it is. */
export function looseTabs<T extends { shelfId?: string; url: string }>(tabs: T[], shelf: Shelf): T[] {
  return tabs.filter((t) => !boundItem(t, shelf));
}

/** The live tab for a kept page, if it is open. */
export function tabForItem<T extends { shelfId?: string; url: string }>(tabs: T[], item: ShelfItem, shelf: Shelf): T | undefined {
  return tabs.find((t) => t.shelfId === item.id)
    ?? tabs.find((t) => !t.shelfId && boundItem(t, shelf)?.id === item.id);
}
