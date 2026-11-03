// The finder's Ctrl+K overlay, as decisions that can be tested without a screen.

export interface SearchHit { path: string; dir: boolean }

/** Where a chosen hit leads: a folder opens as the place, anything else selects it inside its own folder. */
export type HitTarget = { kind: "open-folder"; path: string } | { kind: "select"; dir: string; name: string };

const split = (path: string): [dir: string, name: string] => {
  const cut = path.lastIndexOf("/");
  return [cut <= 0 ? "/" : path.slice(0, cut), path.slice(cut + 1)];
};

/** Enter opens the hit; Alt+Enter opens the folder that holds it (for a folder, its parent). */
export function hitTarget(hit: SearchHit, alt: boolean): HitTarget {
  const [dir, name] = split(hit.path);
  if (alt) return { kind: "select", dir, name };
  return hit.dir ? { kind: "open-folder", path: hit.path } : { kind: "select", dir, name };
}

/** The highlighted row after an arrow key: it stops at both ends, as a list does. */
export const stepHot = (hot: number, dir: 1 | -1, count: number): number => (count === 0 ? 0 : Math.max(0, Math.min(count - 1, hot + dir)));

/** The second line of a row: the whole path, middle-cut when long so the start and the end both stay readable. */
export function hitPath(path: string, max = 118): string {
  if (path.length <= max) return path;
  const tail = Math.floor((max - 1) * 0.56);
  return `${path.slice(0, max - 1 - tail)}…${path.slice(path.length - tail)}`;
}

/** Strata's footer warning: shown while the index is still being built, since what is listed may be missing entries. */
export const partialResults = (status: "idle" | "building" | "ready", _found: number): boolean => status === "building";

/** What the empty and the unanswered states say. */
export function emptyText(q: string, status: "idle" | "building" | "ready", found: number): string {
  if (!q.trim()) return "Type to search Home and mounted local drives\nFuzzy matching · try a name or path fragment";
  if (found > 0) return "";
  return status === "building" ? "Searching…" : "No matching files or folders";
}

/* ---------------------------------------------------------------- mode, scope, contents */

export type SearchMode = "names" | "contents";
export type SearchScope = "home" | "here";
/** The server's floor for a text search: one letter matches every file on the machine. */
export const CONTENTS_MIN = 2;

export const flipMode = (m: SearchMode): SearchMode => (m === "names" ? "contents" : "names");

/**
 * Does this key switch Names and Contents? Tab and Shift+Tab from the field (focus stays in the
 * field, as in a command palette, so the mode is one key away and nothing else is a tab stop to
 * get lost in; Esc is the way out) and Alt+C from anywhere in the dialog. No Finder key uses
 * Alt+C, and while the dialog is up the Finder's own keys stand down.
 */
export function modeKey(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
  if (e.ctrlKey || e.metaKey) return false;
  if (e.key === "Tab") return !e.altKey;
  return e.altKey && e.key.toLowerCase() === "c";
}

/**
 * Does a press close the dialog? Only one that lands on its own backdrop. The menu of the options
 * is drawn in a Portal, but React sends an event up the COMPONENT tree, so a press on a menu row
 * reached the backdrop's handler as if it had been outside the dialog, and closed it with the
 * choice unmade. The target is the answer, not a flag on the menu.
 */
export const closesOnPress = (target: EventTarget | null, backdrop: EventTarget | null): boolean => target === backdrop;

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** "Home", or the folder's own name. */
export const scopeName = (scope: SearchScope, here: string): string => (scope === "here" && here ? base(here.replace(/\/+$/, "")) || "/" : "Home");
export const scopeRoot = (scope: SearchScope, home: string, here: string): string => (scope === "here" && here ? here : home);
/** Is the scope worth offering? A folder that IS Home is the same search. */
export const hasScopeChoice = (home: string, here: string): boolean => !!here && here.replace(/\/+$/, "") !== home.replace(/\/+$/, "");
export const inScope = (path: string, root: string): boolean => { const r = root.replace(/\/+$/, ""); return path === r || path.startsWith(`${r}/`); };

export const searchPlaceholder = (mode: SearchMode, scope: string): string => (mode === "contents" ? `Search inside files in ${scope}…` : "Search files and folders…");

/** The server answers a path from the machine's root, not from the search root. */
export const grepPath = (home: string, rel: string): string => (rel.startsWith("/") ? rel : `${home.replace(/\/+$/, "")}/${rel}`);

/** One matching line, cut for display: the text trimmed, and the match located in the trimmed text. */
export function splitMatch(text: string, at: number, len: number): { before: string; match: string; after: string } {
  const lead = text.length - text.trimStart().length;
  const t = text.trim(), from = at - lead;
  if (len <= 0 || from < 0 || from + len > t.length) return { before: t, match: "", after: "" };
  return { before: t.slice(0, from), match: t.slice(from, from + len), after: t.slice(from + len) };
}

/** What the list says when a Contents search has no rows: waiting, too short, nothing, or a failure, in a sentence each. */
export function contentsNote(o: { q: string; scope: string; pending: boolean; found: number; error?: string }): string {
  const q = o.q.trim();
  if (!q) return `Search inside files in ${o.scope}\nFinds the files whose text contains your words, with the line`;
  if (q.length < CONTENTS_MIN) return `Type at least ${CONTENTS_MIN} characters to search inside files in ${o.scope}`;
  if (o.found > 0) return "";
  if (o.error) return `Could not search inside files in ${o.scope}\n${o.error}`;
  return o.pending ? "Searching…" : `No file in ${o.scope} contains “${q}”`;
}
