/*
 * The Tasks view's bar, the sections under "All", and which checkout its GitHub
 * block reads.
 *
 * All three were decided inline in TasksPanel.tsx and all three ignored the
 * person's settings. The bar sorted by a hard-coded catalogue order, so the
 * saved order in Settings > Tasks had no effect; "All" drew Local then GitHub
 * in that same fixed order; and the GitHub block took `repos[0]`, which is
 * whichever checkout was worked in last — not the project that is open.
 *
 * Kept as data here so each one can be asserted without a renderer (there is
 * none), and so the component has no order of its own to fall back to.
 */
import type { GitRepoRef } from "../../../shared/types.ts";
import { TASK_SOURCES, type TaskSourceId } from "./taskSources.ts";

export interface TaskTab { id: "all" | TaskSourceId; label: string }

/**
 * The bar: "All" leftmost, then the sources in the saved order.
 *
 * The saved order is `shown`'s — already reconciled and filtered by
 * lib/taskSources.ts — and is never re-sorted here. "All" is first or absent:
 * it is a filter over the sources, and a filter that sits in the middle of
 * what it filters reads as one of them. It is absent when only one source is
 * on, because there is nothing for it to be all of.
 */
export function taskTabs(shown: readonly TaskSourceId[]): TaskTab[] {
  const label = (id: TaskSourceId) => TASK_SOURCES.find((s) => s.id === id)?.label ?? id;
  return [
    ...(shown.length > 1 ? [{ id: "all" as const, label: "All" }] : []),
    ...shown.map((id) => ({ id, label: label(id) })),
  ];
}

/** The source blocks "All" draws, and only those: a tracker board is a tab of
 *  its own, and a source this person switched off has no block either. */
export type AllSection = "local" | "github";
export const allSections = (shown: readonly TaskSourceId[]): AllSection[] =>
  shown.filter((id): id is AllSection => id === "local" || id === "github");

const leaf = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;
const trim = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export interface RepoChoice {
  root: string;
  /** Null when this is the open project. Otherwise the header's sentence
   *  naming the checkout shown and why it is not the project's. */
  note: string | null;
}

/**
 * Which checkout the GitHub block reads.
 *
 * The open project's, following `worktreeOf` so a linked worktree answers for
 * its project, and preferring the project's own checkout when both are in the
 * list (issues come from the remote, which they share).
 *
 * `repos` arrives sorted by when each was last worked in, which is the right
 * order for a picker and the wrong answer here: a repo touched more recently
 * than the open project used to take its place, and the block showed another
 * project's issues. When no checkout can answer for the open project the first
 * one is still shown — an empty block helps nobody — but the choice is named
 * in `note` rather than passed off as the project's.
 */
export function taskRepoRoot(repos: readonly GitRepoRef[], open: readonly string[]): RepoChoice {
  if (!repos.length) return { root: "", note: null };
  for (const w of open) {
    const main = repos.find((r) => trim(r.root) === trim(w));
    const inside = repos.find((r) => trim(r.worktreeOf ?? r.root) === trim(w));
    const found = main ?? inside;
    if (found) return { root: found.root, note: null };
  }
  const first = repos[0]!;
  return {
    root: first.root,
    note: open.length
      ? `Showing ${first.root} (${leaf(first.root)}) — none of the open projects (${open.join(", ")}) has a checkout here.`
      : `Showing ${first.root} (${leaf(first.root)}) — no project is open, so there is no project to follow.`,
  };
}
