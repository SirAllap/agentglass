// The project picker's decisions, apart from its screen — see
// web/test/project-pick.test.ts for why they live here.
//
// Paths are the server's: absolute, resolved, `/`-separated. The server never
// hands the picker a `~/…` or a Windows path, so neither is handled here.

import type { GitRepoRef } from "../../../shared/types.ts";

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

/** The project button's accessible name: names, never paths. The full paths
 *  stay on the tooltip, which a screen reader reads as a description. */
export function scopeAria(workspaces: readonly string[], workspace: string | null | undefined): string {
  if (workspace === undefined) return "Reading the open project";
  if (!workspace) return "Every repo on this machine. Open projects";
  return `Open project ${workspaces.map(leaf).join(", ")}. Switch project`;
}

/** Every open project in full, for the tooltip the short label leaves out. */
export function scopeTitle(workspaces: readonly string[]): string {
  return workspaces.join("\n");
}

/**
 * What the Open button sends, or null when it would change nothing.
 *
 * Nothing ticked is null too, not "the whole machine": unticking the last box
 * on the way to ticking another one is not a request to unscope the cockpit.
 * The whole machine is a row of its own in the picker.
 */
export function nextScope(ticked: readonly string[], current: readonly string[]): string[] | null {
  if (!ticked.length || sameSet(ticked, current)) return null;
  return [...ticked];
}

/**
 * What a click on one project's row opens, or null to just close the picker.
 *
 * A project that is not open opens on its own, the one-click path. One that is
 * already open changes nothing, even with others open beside it: narrowing to
 * it reloaded the app, and the row is where a hand reaching for its tick box
 * lands. Unticking the others is how to narrow.
 */
export function clickScope(root: string, workspaces: readonly string[]): string[] | null {
  return workspaces.includes(root) ? null : [root];
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

/**
 * The open paths the list has no project row for: a folder opened as a whole,
 * like a ~/code scope from before there were folders. Without a row of its own
 * nothing on the list says it is what is open.
 *
 * Its ceiling: an open linked worktree whose project is also listed is folded
 * into that project's row by the server, and is called a folder here.
 */
export function openFolders(workspaces: readonly string[], listed: readonly { root: string }[]): string[] {
  return workspaces.filter((w) => !listed.some((r) => trim(r.root) === trim(w)));
}

/** The list plus a row of its own for every open path it lacks, so "Open now"
 *  shows everything that is open and every tick has a row to untick. */
export function withOpenFolders<T extends { root: string }>(listed: readonly T[], workspaces: readonly string[]): (T | GitRepoRef)[] {
  const extra = openFolders(workspaces, listed).map((root): GitRepoRef => ({ root, name: leaf(root), branch: "", dirty: 0, ahead: 0, behind: 0, touchedAt: 0 }));
  return [...listed, ...extra];
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
export function firstRun(listed: readonly unknown[] | null, roots: readonly string[], scanned: boolean, workspaces: readonly string[] | null): boolean {
  // null: the server has not said what is open yet, which is not "nothing".
  return listed !== null && !roots.length && !scanned && workspaces !== null && !workspaces.length;
}

/** Set once the user has answered the startup question (either way), so an
 *  unscoped instance doesn't re-ask on every reload. */
export const PICKER_ANSWERED_KEY = "agentglass.projectChosen";
export const markAnswered = (): void => { try { localStorage.setItem(PICKER_ANSWERED_KEY, "1"); } catch { /* ignore */ } };

/** What a multi-open reports per project (frame 12). */
export type OpenRow = { path: string; state: "opening" | "ok" | "fail" | "ready"; why?: string };

/** After a refused open: which projects can still be opened. The ones whose
 *  folder is gone fail with a reason; the rest are ready and stay ticked. */
export function explainOpen(paths: readonly string[], exists: Readonly<Record<string, boolean>>, serverError: string): OpenRow[] {
  const gone = paths.filter((p) => exists[p] === false);
  return paths.map((p) => exists[p] === false
    ? { path: p, state: "fail" as const, why: `${p} does not exist. It may be on a drive that is not mounted.` }
    : gone.length
      ? { path: p, state: "ready" as const }
      : { path: p, state: "fail" as const, why: serverError });
}
