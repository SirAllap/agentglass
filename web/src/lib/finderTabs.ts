// The Machine finder's folder tabs (Strata's strip above the path row). A tab is
// only the folder it shows: switching goes there like any other "go", so the
// history, the columns and the selection are the finder's own and are not kept
// per tab. That is the ceiling of this model; a tab does not remember the
// columns it had open.

export interface Tabs { paths: string[]; active: number }

export const tabsOf = (path: string): Tabs => ({ paths: [path], active: 0 });

/** A new tab beside the active one, showing `path`, and it becomes the active one. */
export function openTab(t: Tabs, path: string): Tabs {
  const at = t.active + 1;
  return { paths: [...t.paths.slice(0, at), path, ...t.paths.slice(at)], active: at };
}

/** Closing the last tab does nothing: the finder always shows somewhere. */
export function closeTab(t: Tabs, i: number): Tabs {
  if (t.paths.length < 2 || i < 0 || i >= t.paths.length) return t;
  const paths = t.paths.filter((_, k) => k !== i);
  const active = i < t.active ? t.active - 1 : Math.min(t.active, paths.length - 1);
  return { paths, active };
}

export const selectTab = (t: Tabs, i: number): Tabs => (i < 0 || i >= t.paths.length ? t : { ...t, active: i });

/** The tab `by` places along, wrapping round the ends (Ctrl+Tab, Ctrl+Shift+Tab). */
export const stepTab = (t: Tabs, by: number): Tabs => ({ ...t, active: (((t.active + by) % t.paths.length) + t.paths.length) % t.paths.length });

/** The active tab follows the finder: wherever it goes, the tab shows it. */
export const showHere = (t: Tabs, path: string): Tabs => (t.paths[t.active] === path ? t : { ...t, paths: t.paths.map((p, k) => (k === t.active ? path : p)) });

/** What a tab is called: the folder's name, and ~ for home. */
export function tabLabel(path: string, home: string): string {
  if (path === home) return "~";
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name || "/";
}

/** Strata's Ctrl+Shift+Page Up / Down: the active tab one place left or right, stopping at the ends. */
export function moveTab(t: Tabs, by: 1 | -1): Tabs {
  const to = t.active + by;
  if (to < 0 || to >= t.paths.length) return t;
  const paths = t.paths.slice();
  [paths[t.active], paths[to]] = [paths[to]!, paths[t.active]!];
  return { paths, active: to };
}

/** Strata's strip scrolls sideways under either wheel, 36 px a notch (tabs/strip.rs). */
export const tabWheel = (dx: number, dy: number): number => { const d = Math.abs(dx) > Math.abs(dy) ? dx : dy; return d === 0 ? 0 : Math.sign(d) * 36; };
