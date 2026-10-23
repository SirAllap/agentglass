/*
 * The sidebar's pinned places are GTK's own bookmarks, the file Strata and every
 * other GTK file manager read: one line per place, `uri` then an optional label.
 * Pinning here pins there, and a place pinned there appears here. A `file://`
 * line is a folder on this machine; any other scheme (sftp, smb...) is a remote
 * the finder shows by its label and opens through the same address flow as the
 * Network dialog. Only the lines this module understands are rewritten; a line
 * it does not (a comment, a blank) is kept where it was.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface Bookmark { uri: string; label: string; /** Set for a `file://` line: the folder on this machine. */ path?: string }

export const bookmarksFile = (): string => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gtk-3.0", "bookmarks");

const PIN_MAX = 40;

const fileUri = (path: string): string => "file://" + path.split("/").map(encodeURIComponent).join("/");

/** Every understood line, in file order, each once. A label is what follows the first space. */
export function parseBookmarks(text: string): Bookmark[] {
  const out: Bookmark[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sp = line.search(/\s/);
    const uri = sp < 0 ? line : line.slice(0, sp);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) || seen.has(uri)) continue;
    seen.add(uri);
    const label = sp < 0 ? "" : line.slice(sp + 1).trim();
    if (uri.startsWith("file://")) {
      let path: string;
      try { path = decodeURIComponent(uri.slice("file://".length)); } catch { continue; }
      if (!isAbsolute(path)) continue;
      path = path.length > 1 ? path.replace(/\/+$/, "") : path;
      if (path === "/") continue;
      out.push({ uri, label: label || basename(path), path });
    } else {
      let host = "";
      try { host = new URL(uri).hostname; } catch { /* a label is enough */ }
      out.push({ uri, label: label || host || uri });
    }
  }
  return out.slice(0, PIN_MAX);
}

export function readBookmarks(): Bookmark[] {
  try { return parseBookmarks(readFileSync(bookmarksFile(), "utf8")); } catch { return []; }
}

/** The file with `path` added (at the end) or removed. Lines it does not understand stay. */
export function toggledText(text: string, path: string): string {
  const uri = fileUri(path);
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim().split(/\s/)[0] === uri || (() => { try { return l.trim().startsWith("file://") && decodeURIComponent(l.trim().split(/\s/)[0]!.slice(7)).replace(/\/+$/, "") === path; } catch { return false; } })());
  if (at >= 0) { lines.splice(at, 1); return lines.join("\n"); }
  const body = text.replace(/\n+$/, "");
  return (body ? body + "\n" : "") + `${uri} ${basename(path)}\n`;
}

/** Pin or unpin a folder of this machine; the answer is the list as it now stands. */
export function toggleBookmark(path: unknown): { ok: boolean; error?: string; bookmarks?: Bookmark[] } {
  if (typeof path !== "string" || !isAbsolute(path) || path === "/" || path.includes("\0") || path.includes("\n")) return { ok: false, error: "an absolute folder path is needed" };
  const file = bookmarksFile();
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { /* none yet */ }
  const next = toggledText(text, path.replace(/\/+$/, ""));
  if (parseBookmarks(next).length > PIN_MAX && next.length > text.length) return { ok: false, error: `at most ${PIN_MAX} pinned places` };
  try {
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    const tmp = file + ".agx-tmp";
    writeFileSync(tmp, next);
    renameSync(tmp, file);
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "could not write the bookmarks" }; }
  return { ok: true, bookmarks: readBookmarks() };
}

/** Unpin one line by its address: the way a remote (sftp, smb) goes, which has no folder here to toggle. Nothing else is touched. */
export function removeBookmarkUri(uri: unknown): { ok: boolean; error?: string; bookmarks?: Bookmark[] } {
  if (typeof uri !== "string" || !/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) || uri.includes("\n")) return { ok: false, error: "a place address is needed" };
  const file = bookmarksFile();
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return { ok: true, bookmarks: [] }; }
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim().split(/\s/)[0] === uri);
  if (at < 0) return { ok: true, bookmarks: readBookmarks() };
  lines.splice(at, 1);
  try {
    const tmp = file + ".agx-tmp";
    writeFileSync(tmp, lines.join("\n"));
    renameSync(tmp, file);
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "could not write the bookmarks" }; }
  return { ok: true, bookmarks: readBookmarks() };
}
