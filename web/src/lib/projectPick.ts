// The project picker's decisions, apart from its screen — see
// web/test/project-pick.test.ts for why they live here.
//
// Paths are the server's: absolute, resolved, `/`-separated. The server never
// hands the picker a `~/…` or a Windows path, so neither is handled here.

const leaf = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const within = (p: string, dir: string) => {
  const a = trim(p), d = trim(dir);
  return a === d || a.startsWith(d === "/" ? "/" : d + "/");
};
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** The project button's text: one folder's name, or the first and how many
 *  more. Null with nothing open, where the caller has its own words. */
export function scopeLabel(workspaces: readonly string[]): string | null {
  if (!workspaces.length) return null;
  const first = leaf(workspaces[0]!);
  return workspaces.length === 1 ? first : `${first} +${workspaces.length - 1}`;
}

/** Every open project in full, for the tooltip the short label leaves out. */
export function scopeTitle(workspaces: readonly string[]): string {
  return workspaces.join("\n");
}

/**
 * What the Open button sends, or null when it would change nothing.
 *
 * Nothing ticked is null too, not "the whole machine": unticking the last box
 * on the way to ticking another one is not a request to unscope the cockpit,
 * and the picker no longer offers the whole machine at all.
 */
export function nextScope(ticked: readonly string[], current: readonly string[]): string[] | null {
  if (!ticked.length || sameSet(ticked, current)) return null;
  return [...ticked];
}

/** "All projects" is open when the scope is exactly the added folders. */
export function allOpen(workspaces: readonly string[], roots: readonly string[]): boolean {
  return roots.length > 0 && sameSet(workspaces.map(trim), roots.map(trim));
}

/**
 * The projects being opened that no added folder covers.
 *
 * Opening one of those — from a scan, a clone, a new project — adds it as a
 * folder of its own, or it would be missing from the list the next time the
 * picker opens and there would be no way back to it but to find it again.
 */
export function rootsToAdd(opening: readonly string[], roots: readonly string[]): string[] {
  return opening.filter((p) => !roots.some((r) => within(p, r)));
}

/**
 * Does this directory belong to one of the open projects? Nothing open is the
 * unscoped cockpit, where everything does.
 *
 * Any of them, not the first: a panel filtering by `workspace` alone showed a
 * cockpit opened on two projects and hid the second one's chats.
 */
export function inOpenProjects(dir: string, workspaces: readonly string[]): boolean {
  return !workspaces.length || workspaces.some((w) => within(dir, w));
}

/** Ticked when the picker opens: the open projects that the list can show. */
export function initialTicks(workspaces: readonly string[], listed: readonly { root: string }[]): string[] {
  return workspaces.filter((w) => listed.some((r) => r.root === w));
}

/**
 * The project to open without being asked, after a folder is added.
 *
 * Only when the answer is not a guess: the folder held exactly one project and
 * nothing is open yet. Anything else waits for a tick.
 */
export function autoPick(listed: readonly { root: string }[], workspaces: readonly string[]): string | null {
  return !workspaces.length && listed.length === 1 ? listed[0]!.root : null;
}

/**
 * Is this the first run — the screen that asks for a folder instead of a list?
 *
 * Only with nothing to show and nothing open: no folder added, not looking,
 * the list read, and no project open. The last is for somebody upgrading with
 * a project open and no folders yet, who was told to add the folder their
 * projects live in above the row of the project they had open.
 */
export function firstRun(listed: readonly unknown[] | null, roots: readonly string[], scanned: boolean, workspaces: readonly string[]): boolean {
  return listed !== null && !roots.length && !scanned && !workspaces.length;
}
