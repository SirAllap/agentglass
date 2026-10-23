/*
 * What the finder's context menu offers, and what a file operation needs to
 * know, apart from drawing either.
 *
 * The menus are Strata's, item for item (its file, folder and empty-space
 * menus, in that order and with that wording): the model is a list of groups,
 * the screen draws a rule between groups. Which operation an item runs, which
 * names a rename may take and what the clipboard holds are decisions, so they
 * live here and are tested; the server judges the rest (where, how, whether).
 */
export type Target = "file" | "folder" | "empty";

export type OpId =
  | "folder-with" | "open" | "open-with" | "preview" | "print" | "terminal" | "open-in"
  | "cut" | "copy" | "duplicate" | "rename" | "move-to" | "copy-to" | "compress"
  | "pin" | "customize" | "copy-path" | "copy-name" | "props" | "trash" | "delete"
  | "new-folder" | "new-file" | "paste" | "select-all" | "refresh" | "hidden"
  /** One of the person's own actions (Item.action says which) and the entry that holds the ones that go in a submenu. */
  | "action" | "actions";

export interface Item {
  id: OpId;
  label: string;
  /** The shortcut as Strata prints it. */
  keys?: string;
  /** Drawn in the warning colour: the one that cannot be taken back. */
  danger?: boolean;
  disabled?: boolean;
  /** Not built yet: the item is there (the menu is Strata's) and says so instead of doing nothing. */
  later?: string;
  /** The id of the person's own action this item runs (id "action"). */
  action?: string;
  /** What the entry opens to the side (id "actions"). */
  sub?: Item[];
}

export interface MenuCtx {
  /** How many entries the menu acts on. */
  count: number;
  /** Something is on the clipboard. */
  canPaste: boolean;
  /** Hidden files are showing, so the toggle reads "Hide". */
  hidden: boolean;
  /** The one file can be shown in the preview panel (Quick preview, Print). */
  previewable: boolean;
  pinned?: boolean;
}

/** The menu for a right-click, in Strata's order. */
export function menuFor(target: Target, c: MenuCtx): Item[][] {
  if (target === "empty") {
    return [
      [{ id: "new-folder", label: "New Folder", keys: "Ctrl+Shift+N" }, { id: "new-file", label: "New File" }, { id: "paste", label: "Paste", keys: "Ctrl+V", disabled: !c.canPaste }],
      [{ id: "open-with", label: "Open With…" }, { id: "terminal", label: "Open in Terminal", keys: "Ctrl+Alt+T" }],
      [{ id: "select-all", label: "Select All", keys: "Ctrl+A" }, { id: "refresh", label: "Refresh", keys: "F5" }, { id: "hidden", label: c.hidden ? "Hide Hidden Files" : "Show Hidden Files", keys: "Ctrl+H" }],
      [{ id: "customize", label: "Customize…" }, { id: "props", label: "Properties" }],
    ];
  }
  const folder = target === "folder";
  const open: Item[] = [
    { id: "open", label: "Open", keys: "Enter" },
    { id: "open-with", label: "Open With…" },
    ...(folder
      ? [{ id: "terminal" as const, label: "Open in Terminal", keys: "Ctrl+Alt+T" }, { id: "open-in" as const, label: "Open in New Tab", keys: "Ctrl+Enter" }]
      : [{ id: "preview" as const, label: "Quick preview", keys: "Space", disabled: !c.previewable }, { id: "print" as const, label: "Print" }]),
  ];
  return [
    [{ id: "folder-with", label: "New Folder with Selection" }],
    open,
    [
      { id: "cut", label: "Cut", keys: "Ctrl+X" }, { id: "copy", label: "Copy", keys: "Ctrl+C" },
      { id: "duplicate", label: "Duplicate", keys: "Ctrl+D" }, { id: "rename", label: "Rename", keys: "F2 / Ctrl+R", disabled: c.count > 1 },
    ],
    [{ id: "move-to", label: "Move to…" }, { id: "copy-to", label: "Copy to…" }],
    [{ id: "compress", label: "Compress…" }],
    [
      ...(folder ? [{ id: "pin" as const, label: c.pinned ? "Unpin from sidebar" : "Pin to sidebar" }] : []),
      { id: "customize", label: "Customize…" }, { id: "copy-path", label: "Copy path" }, { id: "copy-name", label: "Copy name" },
      { id: "props", label: "Properties", keys: "Alt+Enter", disabled: c.count > 1 },
    ],
    [{ id: "trash", label: "Move to Trash", keys: "Delete" }, { id: "delete", label: "Permanently delete", keys: "Shift+Delete", danger: true }],
  ];
}

/**
 * The menu with the person's own actions in it: before Cut/Copy in the file and folder menus
 * (after the opening commands), after Open With in the empty-space menu.
 */
export function withActions(groups: Item[][], actions: Item[] | null): Item[][] {
  if (!actions || !actions.length) return groups;
  const at = groups.findIndex((g) => g.some((i) => i.id === "cut"));
  const i = at >= 0 ? at : Math.min(2, groups.length);
  return [...groups.slice(0, i), actions, ...groups.slice(i)];
}

/** A path as Strata shortens it in the menu header: home as "~", the middle given up when it is long, the end (what matters) kept. */
export function shortPath(path: string, home: string, max = 36): string {
  const p = home && (path === home || path.startsWith(home + "/")) ? "~" + path.slice(home.length) : path;
  if (p.length <= max) return p;
  const head = Math.ceil((max - 1) * 0.4);
  return `${p.slice(0, head)}…${p.slice(p.length - (max - 1 - head))}`;
}

/** The menu's header: what it is about. One entry names itself; several say how many. */
export function menuHead(names: readonly string[], dir: string, home = ""): { title: string; sub: string } {
  if (names.length === 1) return { title: names[0]!, sub: shortPath(`${dir.replace(/\/$/, "")}/${names[0]}`, home) };
  return { title: `${names.length} items`, sub: shortPath(dir, home) };
}

/** What an operation moves, held until a Paste: a cut is a move, a copy is a copy. */
export interface Clip { mode: "cut" | "copy"; dir: string; names: string[] }

export function clipPaths(c: Clip): string[] {
  return c.names.map((n) => `${c.dir.replace(/\/$/, "")}/${n}`);
}

/** Paste is a move for a cut and a copy for a copy; into where it came from, a copy keeps both, and a cut is nothing to do. */
export function pasteOp(c: Clip | null, into: string): { op: "copy" | "move"; conflict: "keep-both" } | "nothing" | "empty" {
  if (!c || !c.names.length) return "empty";
  if (c.mode === "cut" && c.dir === into) return "nothing";
  return { op: c.mode === "cut" ? "move" : "copy", conflict: "keep-both" };
}

/** What dropping rows on a folder does: a move, or a copy with Ctrl; nothing into the folder they are in, and never into themselves or something inside them. */
/** The volume a path is on: the longest mount point it is under, or `/`. */
export function volumeOf(path: string, mounts: readonly string[]): string {
  let best = "/";
  for (const m of mounts) { const r = m.replace(/\/+$/, "") || "/"; if ((path === r || path.startsWith(r === "/" ? "/" : `${r}/`)) && r.length > best.length) best = r; }
  return best;
}

/**
 * What a drop does (Strata's services/transfer_action.rs): Ctrl copies, Shift
 * moves, and with neither it moves on the same volume and copies across
 * volumes. Strata asks first across volumes (copy is its default answer); that
 * question is asked by the caller (dropAsks); the plan is its default. A drop in the folder it came from does
 * nothing unless it is a copy.
 */
export function dropPlan(srcDir: string, names: readonly string[], dest: string, ctrl: boolean, more: { shift?: boolean; mounts?: readonly string[] } = {}): { op: "move" | "copy"; conflict: "keep-both" } | "nothing" | "inside" {
  if (!names.length) return "nothing";
  for (const n of names) {
    const own = (srcDir === "/" ? "" : srcDir) + "/" + n;
    if (dest === own || dest.startsWith(own + "/")) return "inside";
  }
  if (!ctrl && dest === srcDir) return "nothing";
  const across = !!more.mounts && volumeOf(srcDir, more.mounts) !== volumeOf(dest, more.mounts);
  return { op: ctrl ? "copy" : more.shift ? "move" : across ? "copy" : "move", conflict: "keep-both" };
}

/** Strata's default transfer strategy is Ask: a drop with no modifier across volumes asks before it copies (copy is the default answer). */
export function dropAsks(srcDir: string, dest: string, ctrl: boolean, more: { shift?: boolean; mounts?: readonly string[] } = {}): boolean {
  return !ctrl && !more.shift && !!more.mounts && volumeOf(srcDir, more.mounts) !== volumeOf(dest, more.mounts);
}

/** A press outside the name being typed: a rename keeps what was typed, a new entry is dropped (Strata's editor). */
export const outsidePress = (renaming: boolean): "submit" | "cancel" => (renaming ? "submit" : "cancel");

/** A name somebody typed for a rename or a new folder: the same rule the server holds, said before the round trip. */
export function nameProblem(raw: string, taken: readonly string[], was?: string): string | null {
  const n = raw.trim();
  if (!n) return "A name is needed";
  if (n === "." || n === "..") return "That is not a name";
  if (n.includes("/")) return "A name cannot contain /";
  if (new TextEncoder().encode(n).length > 255) return "That name is too long";
  if (n !== was && taken.includes(n)) return `${n} already exists`;
  return null;
}

/** The part of a name a rename selects first: the stem, not the extension, as Strata's editor does. */
/** Strata's name for a folder made by the key: "new folder", then "new folder (1)", "new folder (2)"… against what is already there (case aside, as the server's rule is). */
export function freeName(base: string, taken: readonly string[]): string {
  const have = new Set(taken.map((n) => n.toLowerCase()));
  if (!have.has(base)) return base;
  for (let i = 1; ; i++) if (!have.has(`${base} (${i})`)) return `${base} (${i})`;
}

export function stemEnd(name: string): number {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

/** Strata's heading for an operation that failed; the server's own words follow it. */
export function failedNote(op: string, error: string | undefined): string {
  const title = op === "rename" ? "Unable to rename item" : op === "trash" ? "Unable to move to Trash" : op === "restore" ? "Unable to restore" : op === "empty-trash" ? "Unable to empty Trash" : "Unable to complete operation";
  return error ? `${title}: ${error}` : title;
}

/** "Move to Trash", "Permanently delete": the one-line answer in the footer after it ran. */
export function doneNote(op: string, n: number, name: string): string {
  const what = n === 1 ? name : `${n} items`;
  switch (op) {
    case "trash": return `Moved ${what} to the trash`;
    case "delete": return `Deleted ${what}`;
    case "copy": return `Copied ${what}`;
    case "move": return `Moved ${what}`;
    case "duplicate": return `Duplicated ${what}`;
    case "rename": return `Renamed ${what}`;
    case "mkdir": return `Created folder ${what}`;
    case "newfile": return `Created ${what}`;
    case "compress": return `Compressed ${what}`;
    case "undo": return `Undid: ${what}`;
    case "redo": return `Redid: ${what}`;
    default: return "Done";
  }
}

/** The words of the confirmation that comes before a permanent delete: the count and the names, up to a few. */
export function deleteWords(names: readonly string[]): { title: string; body: string } {
  const shown = names.slice(0, 5).map((n) => `“${n}”`).join(", ");
  const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
  return {
    title: names.length === 1 ? `Permanently delete “${names[0]}”?` : `Permanently delete ${names.length} items?`,
    body: `${shown}${more} will be deleted for good. This cannot be undone.`,
  };
}

/** The name Compress offers: one item keeps its own, several are an "Archive". */
export function archiveName(names: readonly string[]): string {
  return names.length === 1 ? names[0]! : "Archive";
}

/** "1 file", "2 files, 1 folder": the line under Compress' title. */
export function compressSub(items: readonly { dir: boolean }[]): string {
  const d = items.filter((i) => i.dir).length, f = items.length - d;
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return [f ? part(f, "file") : "", d ? part(d, "folder") : ""].filter(Boolean).join(", ");
}

/** The formats whose tool can lock an archive; tar has no such thing, and the server refuses it. */
export function formatTakesPassword(f: "zip" | "7z" | "tar.gz" | "tar"): boolean {
  return f === "zip" || f === "7z";
}

export type Who = "owner" | "group" | "others";
const SHIFT: Record<Who, number> = { owner: 6, group: 3, others: 0 };

/** A mode as the read/write/execute toggles of Properties, owner first. */
export function modeBits(mode: number): Record<Who, [boolean, boolean, boolean]> {
  const of = (w: Who): [boolean, boolean, boolean] => { const b = (mode >> SHIFT[w]) & 7; return [!!(b & 4), !!(b & 2), !!(b & 1)]; };
  return { owner: of("owner"), group: of("group"), others: of("others") };
}

/** The mode with one toggle flipped (0 read, 1 write, 2 execute); setuid and the like are left as they are. */
export function toggleMode(mode: number, who: Who, bit: 0 | 1 | 2): number {
  return mode ^ (4 >> bit << SHIFT[who]);
}

/** "-rw-r--r--", the line ls prints, which Properties shows next to the octal. */
export function modeSymbolic(mode: number, kind: "dir" | "file" | "link"): string {
  const b = modeBits(mode);
  const rwx = (t: [boolean, boolean, boolean]) => (t[0] ? "r" : "-") + (t[1] ? "w" : "-") + (t[2] ? "x" : "-");
  return (kind === "dir" ? "d" : kind === "link" ? "l" : "-") + rwx(b.owner) + rwx(b.group) + rwx(b.others);
}

/** "Allow executing file as a program": on when any execute bit is set; flipping it sets or clears all three, as chmod +x and -x do. */
export const canExec = (mode: number): boolean => (mode & 0o111) !== 0;
export const toggleExec = (mode: number): number => (canExec(mode) ? mode & ~0o111 : mode | 0o111);

/** The line under the name in Properties: what the entry is, in words, as Strata's type description. */
const KIND_WORDS: Record<string, string> = {
  md: "Markdown document", txt: "Plain text document", json: "JSON document", html: "HTML document", css: "CSS stylesheet", js: "JavaScript source", ts: "TypeScript source",
  py: "Python script", sh: "Shell script", pdf: "PDF document", png: "PNG image", jpg: "JPEG image", jpeg: "JPEG image", gif: "GIF image", svg: "SVG image", webp: "WebP image",
  mp3: "MP3 audio", mp4: "MPEG-4 video", zip: "ZIP archive", gz: "Gzip archive", tar: "TAR archive", "7z": "7-Zip archive",
};
export function kindWords(name: string, kind: "dir" | "file" | "link"): string {
  if (kind === "dir") return "Folder";
  if (kind === "link") return "Link";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return KIND_WORDS[ext] ?? (ext ? `${ext.toUpperCase()} file` : "File");
}

/**
 * The folders of the place the picker is IN, or null while they load. Each list carries the folder it was read from:
 * the click that enters a folder renders the new place before the effect clears the old list, and a second click of
 * a double-click on a name in that frame went into ".../sub/sub", which does not exist.
 */
export const foldersOf = (at: string, loaded: { at: string; names: readonly string[] } | null): readonly string[] | null => (loaded && loaded.at === at ? loaded.names : null);

/** Why a folder cannot take these: into itself or below itself, or a move to where it already is. Null when it can. */
export function destProblem(paths: readonly string[], dest: string, op: "move" | "copy" = "move"): string | null {
  const d = dest.replace(/\/$/, "");
  for (const p of paths) {
    if (d === p || d.startsWith(p + "/")) return "A folder cannot go into itself";
    if (op === "move" && p.slice(0, p.lastIndexOf("/")) === d) return "It is already in that folder";
  }
  return null;
}

/** The question before the trash is emptied (`all`), or one entry in it is deleted: the count and the names, up to a few. */
export function trashDeleteWords(names: readonly string[], all = false): { title: string; body: string; confirm: string } {
  if (all) return {
    title: "Empty Trash?",
    body: `${names.length === 1 ? "1 item" : `${names.length} items`} will be gone from the trash for good. This cannot be undone.`,
    confirm: "Empty Trash",
  };
  const shown = names.slice(0, 5).map((n) => `“${n}”`).join(", ");
  const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
  return {
    title: names.length === 1 ? `Delete “${names[0]}” for good?` : `Delete ${names.length} items for good?`,
    body: `${shown}${more} will be gone from the trash for good. This cannot be undone.`,
    confirm: "Delete for good",
  };
}

/** What Strata says in the footer for two seconds when a command has nothing to act on. */
const NOTHING: Partial<Record<OpId, string>> = {
  cut: "Nothing to cut", copy: "Nothing to copy", duplicate: "Nothing to copy", "copy-to": "Nothing to copy", "copy-path": "Nothing to copy", "copy-name": "Nothing to copy",
  "move-to": "Nothing to move", trash: "Nothing to delete", delete: "Nothing to delete", rename: "Nothing to rename", compress: "Nothing to compress",
  preview: "Nothing to preview", pin: "Nothing to pin", open: "Nothing to open", "open-with": "Nothing to open", "open-in": "Nothing to open", print: "Nothing to open",
};
export const nothingTo = (id: OpId): string => NOTHING[id] ?? "Nothing to open";

/** Recent lists files from everywhere, so nothing is made, pasted or renamed in it: Strata's two refusals. Null when the command is allowed. */
export function cantHere(id: OpId, recent: boolean): string | null {
  if (!recent) return null;
  if (id === "new-folder" || id === "new-file" || id === "folder-with" || id === "paste") return "Can\u2019t create items here";
  if (id === "rename") return "Can\u2019t rename items here";
  return null;
}

/** How far a copy or move has got, 0 to 1; null while the total is still being counted. */
export function jobFraction(j: { state: string; total: number | null; done: number }): number | null {
  if (j.state === "done") return 1;
  if (j.total === null || j.total <= 0) return null;
  return Math.min(1, j.done / j.total);
}

/** Strata's footer button for background jobs: "2 running", or, once they end, "3 finished" (+ " · failures"). Empty when there is nothing to show. */
export function jobsLabel(jobs: readonly { state: string }[]): string {
  const running = jobs.filter((j) => j.state === "running").length;
  if (running) return `${running} running`;
  const finished = jobs.length;
  if (!finished) return "";
  return jobs.some((j) => j.state === "error") ? `${finished} finished \u00b7 failures` : `${finished} finished`;
}

/** "42 s", "3 min 05 s", "1 h 02 min": how long a job ran, the way Strata's rows write it. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

/** The status word next to a job's name: Strata's "Running for 4 s", "Done in 2 s", "Failed after 1 s", "Cancelled after 3 s". */
export function jobStatus(j: { state: string; started: number; ended?: number }, now: number): string {
  const t = elapsedText((j.ended ?? now) - j.started);
  return j.state === "running" ? `Running for ${t}` : j.state === "done" ? `Done in ${t}` : j.state === "error" ? `Failed after ${t}` : `Cancelled after ${t}`;
}

/** Open With's search: every word must be in the name or the description, either case. */
export function filterApps<T extends { name: string; comment: string }>(apps: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...apps];
  return apps.filter((a) => { const h = `${a.name} ${a.comment}`.toLowerCase(); return words.every((w) => h.includes(w)); });
}
