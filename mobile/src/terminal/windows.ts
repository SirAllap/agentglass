/*
 * Which windows a phone shows, and how it groups and names them.
 *
 * The strip used to be "every window of one tmux session", named the way tmux
 * names them (`2 AI00`). On a machine with an orchestrator driving three
 * workers in three repositories that is the wrong unit twice over: a session is
 * where tmux put the windows, not what they are for, and an index prefix says
 * nothing about which one is asking for you. The desk already answers both —
 * its strip is grouped by PROJECT, with a status dot on every window
 * (`web/src/lib/tabGroups.ts`) — so this is the same answer, cut to a phone:
 * the strip is the current project's windows, and the switcher is every
 * project's.
 *
 * Pure, and out of the screen, because "which windows are in this project" and
 * "which one needs you" are decisions worth a test, and what a dot looks like
 * is not.
 *
 * Ceilings, stated so a missing feature reads as a limit and not a miss: the
 * desk's Settings prefix rule (`agx=agentglass`) is not here — the phone has no
 * place to write one — and a window whose project the server has not resolved
 * yet (`repo` absent, for one poll) files under "other" until it has.
 */
import { worstStatus, type WindowStatus } from "../../../shared/windowStatus.ts";
import type { Tab } from "./tabs.ts";

export const OTHER = "other";

/** The last segment of a directory: what a person calls a checkout. */
export const leafOf = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

/**
 * The project a window belongs to, as the desk's `groupOf` answers it: the
 * group it was put in by hand, else its repository's name (the main checkout,
 * so every worktree of one project shares it), else "other".
 */
export function groupOf(tab: Tab): string {
  if (tab.group) return tab.group;
  if (tab.repo) return leafOf(tab.repo);
  return OTHER;
}

/** Groups are the same group whatever their case: `Orbit` and `orbit` are one. */
export const groupKey = (tab: Tab): string => groupOf(tab).toLowerCase();

/** What is being said about a window right now: the server's word, overruled
 *  by a held gate — a gate IS the fact, and the poll may be two seconds behind. */
export function statusOf(tab: Tab, asking: ReadonlySet<string>): WindowStatus | undefined {
  return asking.has(tab.paneId) ? "waiting" : tab.status;
}

/** The dot's colour role. `none` is a window with no agent in it, which is a
 *  different claim from an agent that is `idle` — and drawn paler. */
export type Dot = "needs" | "error" | "working" | "done" | "idle" | "none";

export function dotOf(status: WindowStatus | undefined): Dot {
  switch (status) {
    case "waiting": return "needs";
    case "error": return "error";
    case "working": return "working";
    case "done": return "done";
    case "idle": return "idle";
    default: return "none";
  }
}

/** How a window's state reads in a line of a list or to a screen reader. */
export const DOT_WORDS: Record<Dot, string> = {
  needs: "needs you",
  error: "hit an error",
  working: "working",
  done: "finished",
  idle: "idle",
  none: "no agent",
};

/** Pinned first, then whatever `then` ranks higher, and otherwise the order
 *  the answer came in — tmux's own (the sort is stable). */
function pinnedFirst(tabs: readonly Tab[], then: (t: Tab) => number = () => 0): Tab[] {
  return [...tabs].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || then(b) - then(a));
}

/**
 * The strip: only the windows of the project the current window is in.
 *
 * Nothing when nothing is open — there is no project to be in. The current
 * window is always among them by construction, so the selected underline
 * cannot fall off a strip that filtered its own selection out.
 */
export function stripFor(all: readonly Tab[], current: Tab | null | undefined): Tab[] {
  if (!current) return [];
  const key = groupKey(current);
  const here = all.filter((t) => groupKey(t) === key);
  return pinnedFirst(here.some((t) => t.paneId === current.paneId) ? here : [current, ...here]);
}

function needsYou(tabs: readonly Tab[], asking: ReadonlySet<string>): number {
  return tabs.filter((t) => statusOf(t, asking) === "waiting").length;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "3 windows · 1 needs you" — the second half only when it is news. */
export function subline(tabs: readonly Tab[], asking: ReadonlySet<string>): string {
  const needs = needsYou(tabs, asking);
  const windows = plural(tabs.length, "window", "windows");
  return needs ? `${windows} · ${needs} needs you` : windows;
}

export interface SwitcherGroup {
  key: string;
  label: string;
  tabs: Tab[];
  /** How many of them are waiting on you. */
  needs: number;
  /** Shown as rows; otherwise folded to one line of names. */
  open: boolean;
  /** The project the phone is looking at now. */
  current: boolean;
}

/** Every word of the query is in the text, whatever order — a phone keyboard
 *  is not a place to type a phrase exactly. */
function matches(text: string, query: string): boolean {
  const hay = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
}

/**
 * The switcher's groups, in the order they are read.
 *
 * Projects with something waiting on you come first, then the one you are in,
 * then the rest as tmux ordered them. Inside a project the pinned window (the
 * orchestrator) is first and the ones waiting on you follow it, so "which
 * window is asking" is answered before any row is read.
 *
 * Only the current project is open, and any the person opened; searching
 * opens every group that has a match, because a folded match is a match nobody
 * can see. A group whose NAME matches keeps all its windows.
 */
export function switcherGroups(
  all: readonly Tab[],
  options: { query: string; currentKey: string | null; asking: ReadonlySet<string>; expanded: ReadonlySet<string> },
): SwitcherGroup[] {
  const { query, currentKey, asking, expanded } = options;
  const byKey = new Map<string, { label: string; tabs: Tab[] }>();
  for (const tab of all) {
    const key = groupKey(tab);
    const at = byKey.get(key);
    if (at) at.tabs.push(tab);
    else byKey.set(key, { label: groupOf(tab), tabs: [tab] });
  }
  const searching = query.trim().length > 0;
  const out: SwitcherGroup[] = [];
  for (const [key, { label, tabs }] of byKey) {
    const kept = !searching || matches(label, query)
      ? tabs
      : tabs.filter((t) => matches(`${t.name} ${t.label} ${leafOf(t.where)}`, query));
    if (!kept.length) continue;
    const rows = pinnedFirst(kept, (t) => Number(statusOf(t, asking) === "waiting"));
    out.push({
      key, label, tabs: rows,
      needs: needsYou(rows, asking),
      current: key === currentKey,
      open: searching || key === currentKey || expanded.has(key),
    });
  }
  return out.sort((a, b) => Number(b.needs > 0) - Number(a.needs > 0) || Number(b.current) - Number(a.current));
}

/**
 * The second line of a window's row: what it is doing, then where, or — when
 * it is stopped at a gate — the exact thing it is asking to do, because that
 * is what decides whether to go there.
 */
export function rowSub(tab: Tab, status: WindowStatus | undefined, gateDetail?: string): string {
  const dot = dotOf(status);
  if (dot === "needs" && gateDetail) return `needs you · Allow “${gateDetail}”?`;
  return [dot === "none" ? "" : DOT_WORDS[dot], leafOf(tab.where)].filter(Boolean).join(" · ");
}

/** Whether `/git/status` for one checkout has anything uncommitted. */
export function isDirty(answer: { repos?: { files?: unknown[] }[] } | null | undefined): boolean {
  const first = Array.isArray(answer?.repos) ? answer!.repos![0] : undefined;
  return Array.isArray(first?.files) && first!.files!.length > 0;
}

/** Worst first: a folded group's dot is its most urgent window's. */
export function worstOf(tabs: readonly Tab[], asking: ReadonlySet<string>): WindowStatus | undefined {
  return worstStatus(tabs.map((t) => statusOf(t, asking)));
}
