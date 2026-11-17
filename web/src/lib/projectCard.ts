/*
 * What the project card decides, apart from how it draws.
 *
 * Choosing a project is the one picker card (components/PickerCard.tsx) under
 * the top bar's project button. This module turns the server's repo list into
 * what that card shows: which projects sit on the "Recent" shelf, which group
 * a row belongs to (a folder, Worktrees, Hidden), the one-line preview of a
 * folded folder, and the path a row shows when it is too long.
 */
import type { GitRepoRef } from "../../../shared/types.ts";
import { parentOf, tildify } from "./projectsPaths.ts";

export const RECENT_DAYS = 7;
export const SHELF_SIZE = 3;
export const GROUP_WORKTREES = "worktrees";
export const GROUP_HIDDEN = "hidden";
const DAY = 86_400_000;
const FOLDER = "dir:";

/** A folder's group key, and back. */
export const folderKey = (dir: string): string => FOLDER + dir;
export const isFolderKey = (k: string): boolean => k.startsWith(FOLDER);
export const folderOfKey = (k: string): string => k.slice(FOLDER.length);

/** Which group a repo sits in. Hidden wins over worktree: forgotten is forgotten. */
export function groupOf(r: GitRepoRef, hidden: ReadonlySet<string>): string {
  if (hidden.has(r.root)) return GROUP_HIDDEN;
  if (r.worktreeOf) return GROUP_WORKTREES;
  return folderKey(parentOf(r.root));
}

/**
 * The shelf: projects worked in during the last seven days, newest first by
 * touchedAt, three at most. Worktrees and hidden projects never go on it, and
 * the current project is on it when it qualifies (it is only ticked, not moved).
 */
export function shelfIds(repos: readonly GitRepoRef[], hidden: ReadonlySet<string>, now: number): string[] {
  return repos
    .filter((r) => !r.worktreeOf && !hidden.has(r.root) && r.touchedAt > 0 && now - r.touchedAt <= RECENT_DAYS * DAY)
    .sort((a, b) => b.touchedAt - a.touchedAt)
    .slice(0, SHELF_SIZE)
    .map((r) => r.root);
}

/**
 * A path that fits `max` characters by losing its START, never its end: whole
 * folders go from the left behind a "…", and the last folder (the repo's name)
 * stays whole even when it alone is longer than `max`.
 */
export function cutPath(path: string, max: number): string {
  const p = tildify(path);
  if (p.length <= max) return p;
  const parts = p.split("/");
  const leaf = parts[parts.length - 1] ?? p;
  let out = leaf;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + "/" + out;
    if (next.length + 1 > max) break;
    out = next;
  }
  return out === leaf && parts.length < 2 ? leaf : "…/" + out;
}

/** "web · cli · design-tokens…": the children's names on one line, cut at a name. */
export function folderPreview(names: readonly string[], max: number): string {
  let out = "";
  for (let i = 0; i < names.length; i++) {
    const next = out ? out + " · " + names[i] : names[i]!;
    if (next.length > max) return (out || next.slice(0, Math.max(1, max - 1))) + "…";
    out = next;
  }
  return out;
}

/** A repo's name as a child of its folder: "acme/orbit" under ~/code/acme is "orbit". */
export const shortName = (name: string): string => name.split("/").filter(Boolean).pop() ?? name;

export type CardRow = { id: string; label: string; sub: string; group: string; at: number; branch: string; dirty: number; title: string };

/** Every repo as a card row. The id is the root: it is what opening needs. */
export function cardRows(repos: readonly GitRepoRef[], hidden: ReadonlySet<string>, pathMax = 38): CardRow[] {
  return repos.map((r) => ({
    id: r.root, label: r.name, sub: cutPath(r.root, pathMax), group: groupOf(r, hidden), at: r.touchedAt ?? 0,
    branch: r.branch, dirty: r.dirty, title: r.root,
  }));
}

/** The heading a group wears, and the preview beside it (folders only). */
export function groupHead(key: string, rows: readonly { label: string }[], previewMax = 34): { title: string; preview: string } {
  if (key === GROUP_WORKTREES) return { title: "Worktrees", preview: folderPreview(rows.map((r) => r.label), previewMax) };
  if (key === GROUP_HIDDEN) return { title: "Hidden", preview: "" };
  return { title: tildify(folderOfKey(key)), preview: folderPreview(rows.map((r) => shortName(r.label)), previewMax) };
}

/** Groups in the order drawn: folders (the current one's first, then by size), Worktrees, Hidden. */
export function groupOrder(keys: readonly string[], currentKey: string | null, size: (k: string) => number): string[] {
  const rank = (k: string) => (k === GROUP_HIDDEN ? 2 : k === GROUP_WORKTREES ? 1 : 0);
  return [...keys].sort((a, b) => rank(a) - rank(b) || Number(b === currentKey) - Number(a === currentKey) || size(b) - size(a) || a.localeCompare(b));
}

/** From this many projects the card shows square ticks on every row (several open together). */
export const MULTI_FROM = 20;

/** A click or Enter on a row: with ticks set, an unticked row joins them and a ticked row opens the set. */
export const pickAction = (ticks: ReadonlySet<string>, id: string): "choose" | "toggle" | "scope" =>
  !ticks.size ? "choose" : ticks.has(id) ? "scope" : "toggle";

/** Square ticks show for a long list, or once something is ticked. */
export const multiMode = (total: number, ticked: number): boolean => total >= MULTI_FROM || ticked > 0;

/** How long ago a project was worked in: "now", "5h", "yesterday", "3d". Under an hour is "now". */
export function ageLabel(touchedAt: number, now: number): string {
  const h = Math.floor((now - touchedAt) / 3_600_000);
  if (h < 1) return "now";
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d`;
}

/** The tile's second line: "1h · main"; just the age when there is no branch. */
export const tileSub = (touchedAt: number, branch: string, now: number): string =>
  [ageLabel(touchedAt, now), branch].filter(Boolean).join(" · ");

const HUES = ["--error", "--warning", "--success", "--primary", "--info"] as const;
/** A project's folder colour: the same name always gets the same one. */
export function folderHue(root: string): (typeof HUES)[number] {
  let h = 0;
  for (let i = 0; i < root.length; i++) h = (h * 31 + root.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length]!;
}

/** What "open in a new tab" opens: the open projects plus this one; null when it is open already. */
export const tabScope = (root: string, workspaces: readonly string[]): string[] | null =>
  workspaces.includes(root) ? null : [...workspaces, root];
