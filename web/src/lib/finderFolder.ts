/*
 * What the finder does with a FOLDER, decided once: the preview in the centre
 * pane, and the one action that makes sense for it (and for a file).
 *
 * The pane used to say "A folder — ⏎ to go in" as one flex child per word, so a
 * tall pane spread the sentence down its whole height, and the "To the bench"
 * button behind Enter opened a tab named after the file that was only a shell
 * in the project. A folder now shows what is in it, and each button names what
 * it does.
 */
import type { BrowseEntry } from "../../../shared/types.ts";
import { extChips, type ExtChip } from "./finderFilters.ts";
import { dirsFirst, fileKind, humanBytes } from "./paletteModel.ts";
import { ago } from "./fileRecents.ts";
import type { ViewerKind } from "./finderViewer.ts";

/** How many entries the preview lists. A preview is a glance, not the drawer. */
export const PREVIEW_ROWS = 30;

export interface FolderRow {
  name: string;
  isDir: boolean;
  kind: ReturnType<typeof fileKind>;
  /** "12 items" for a folder, "4.2 KB" for a file; the age follows, so a row
   *  reads "4.2 KB · 3d ago". Nothing the listing did not say is invented. */
  meta: string;
  locked: boolean;
}

export interface FolderPreview {
  name: string;
  /** "3 items", "1 item" — what the header says beside the name. */
  count: string;
  /** Age of the folder itself; empty when its facts have not arrived. */
  modified: string;
  empty: boolean;
  rows: FolderRow[];
  /** Entries past the listed ones, said rather than dropped. */
  more: number;
  chips: ExtChip[];
  hint: string;
}

export const FOLDER_HINT = "Enter opens it · → goes in";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Folders first, then files in the order the listing came; the first
 *  `PREVIEW_ROWS` of that. Chips count FILES only, and over the whole folder
 *  rather than the listed part, so the numbers do not change with the cut. */
export function folderPreview(name: string, entries: BrowseEntry[], mtime: number | null, more = 0, now = Date.now()): FolderPreview {
  const sorted = dirsFirst(entries);
  const rows = sorted.slice(0, PREVIEW_ROWS).map((e): FolderRow => {
    const isDir = e.kind === "dir";
    const size = isDir ? (e.items != null ? plural(e.items, "item") : "") : e.bytes != null ? humanBytes(e.bytes) : "";
    return {
      name: e.name, isDir, kind: fileKind(e.name, isDir),
      meta: [size, e.mtime ? ago(e.mtime, now) : ""].filter(Boolean).join(" · "),
      locked: !!e.locked,
    };
  });
  const total = entries.length + more;
  return {
    name, count: plural(total, "item"), modified: mtime ? ago(mtime, now) : "",
    empty: total === 0, rows, more: Math.max(0, sorted.length - rows.length) + more,
    chips: extChips(entries.filter((e) => e.kind !== "dir").map((e) => e.name)),
    hint: FOLDER_HINT,
  };
}

/* -------------------------------------------------------------- navigation */

/**
 * Where a click on a path (a row of the folder preview, a crumb of the centre
 * header) takes the finder, by the file-manager model: the drawer lists the
 * FOLDER THE ITEM IS IN and the item is the selection. Clicking `notes` in the
 * preview of `~/notes` lists `~/notes` and selects `~/notes/notes`, so the path
 * bar, the input, the count, the stepper and the saved state all follow from
 * the two values and cannot disagree with the centre.
 */
export function goTo(abs: string): { browsePath: string; name: string } {
  const clean = abs.replace(/\/+$/, "") || "/";
  const cut = clean.lastIndexOf("/");
  return { browsePath: clean.slice(0, cut) || "/", name: clean.slice(cut + 1) };
}

/** The absolute path of a preview row. */
export const previewChild = (folder: string, name: string): string => `${folder.replace(/\/+$/, "")}/${name}`;

/* ----------------------------------------------------------------- actions */

export interface PrimaryAction {
  id: "edit" | "terminal";
  label: string;
  title: string;
}

/** The one button that goes to the bench, named for what it does there.
 *  A file that has an editor opens in it; a folder opens a shell in it; a
 *  picture, a PDF or a binary has neither, so none. A file the viewer was
 *  refused (a credential store, a link to a key) is `closed`: the bench refuses
 *  it too, so the editor is not offered for it. */
export function primaryAction(kind: ViewerKind | null, closed = false): PrimaryAction | null {
  if (kind === "dir") return { id: "terminal", label: "Terminal here", title: "Open a bench shell in this folder — it stays open there when you leave the finder" };
  if (!closed && (kind === "markdown" || kind === "code" || kind === "html")) {
    return { id: "edit", label: "Edit in nvim", title: "Edit this file in nvim on the bench — it stays open there when you leave the finder" };
  }
  return null;
}

/** A path as ONE shell word. Single quotes hold everything but a single quote,
 *  which is closed, escaped and reopened. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export type BenchOpen =
  | { tab: "file"; root: string; path: string; title: string }
  | { tab: "term"; root: string; title: string; type: string };

const dirOf = (abs: string) => abs.slice(0, abs.lastIndexOf("/")) || "/";
const baseOf = (abs: string) => abs.slice(abs.lastIndexOf("/") + 1) || abs;

/**
 * What to put on the bench for this action.
 *
 * The bench is keyed by a CHECKOUT, and the server holds every request to it
 * against the open project. A file on the Machine tab lives outside any
 * project, and keying its tab by its own folder made the editor's door refuse
 * it ("outside the open project"): the tab was a shell. So the project stays
 * the bench's root whenever there is one, and the file rides in as a path the
 * server may open on its own rule (`viewableFile`). Without a project, the
 * folder itself is the only root there is.
 *
 * "Terminal here" cannot start a session IN a folder outside a repository —
 * the server only starts one in a checkout — so it opens in the bench root and
 * types the `cd`, Enter included: moving is not something to review first.
 */
export function benchOpen(action: PrimaryAction["id"], abs: string, project: string): BenchOpen {
  if (action === "edit") return { tab: "file", root: project || dirOf(abs), path: abs, title: baseOf(abs) };
  return { tab: "term", root: project || abs, title: baseOf(abs), type: `cd ${shellQuote(abs)}\r` };
}
