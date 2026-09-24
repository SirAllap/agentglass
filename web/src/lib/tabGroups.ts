/*
 * Tab groups: which windows the strip draws together, and in what order.
 *
 * Twenty windows in one row do not fit and cannot be read. What makes them
 * readable is the thing a person already sorts them by — which project each
 * one is working on — so the strip groups them by that, opens the group you
 * are in, and folds every other one into a chip that still shows what its
 * agents are doing.
 *
 * A window's group, first answer wins:
 *
 *   1. its `@agx-group` window option — set by dragging a tab onto a group, or
 *      from tmux itself; the manual override;
 *   2. a prefix rule from Settings (`agx=agentglass`): a window named `agx-…`
 *      goes there whatever folder it runs in. None ship; they are the
 *      tie-break for a window whose folder is not its project — an
 *      orchestrator that lives in one repository and drives another;
 *   3. its project — the main checkout's root, so every worktree of one
 *      repository is one group;
 *   4. "other".
 *
 * Groups are matched by NAME, case-insensitively, so a window dragged onto the
 * `orbit` chip (which sets `@agx-group orbit`) joins the windows that are there
 * because of their folder. The cost is that two different repositories with
 * the same folder name share a group; renaming one's override apart is the way
 * out, and it is rare enough not to key on paths instead.
 *
 * One level only. Nested groups are the next thing after this and are not
 * here.
 */
import type { TmuxWindow } from "../../../shared/types.ts";
import { worstStatus, statusRank, type WindowStatus } from "../../../shared/windowStatus.ts";

export const OTHER = "other";

export interface PrefixRule { prefix: string; group: string }

export interface TabGroup {
  /** Lower-cased name: the identity. */
  key: string;
  /** The name as drawn. */
  label: string;
  /** In strip order: pinned first, then tmux's index. */
  windows: TmuxWindow[];
  /** The most urgent status among its windows. */
  status?: WindowStatus;
  /** Every distinct status in it except idle, most urgent first — the chip's
   *  marks. */
  marks: WindowStatus[];
  /** Lowest window index: where the group sits in the strip. */
  first: number;
}

/** A group's name as the server will store it (`sanitizeGroupName`): at most
 *  32 characters, trimmed — or a window dropped on a long-named group would
 *  land in a new, shorter-named one. */
const label = (s: string) => s.slice(0, 32).trim() || s;
const base = (p: string) => label(p.replace(/\/+$/, "").split("/").pop() || p);

/**
 * Parse the Settings field: `prefix=group` pairs, separated by commas or new
 * lines. Anything that is not a pair is dropped rather than guessed at.
 */
export function parseRules(text: string): PrefixRule[] {
  const out: PrefixRule[] = [];
  for (const part of text.split(/[,\n]/)) {
    const m = /^\s*([^=\s][^=]*?)\s*=\s*(\S.*?)\s*$/.exec(part);
    if (m) out.push({ prefix: m[1]!, group: label(m[2]!) });
  }
  return out;
}

/**
 * The group a window belongs to.
 *
 * `remembered` covers the one sweep after a new directory appears, when the
 * server has not resolved its project yet (`repo` absent): the window stays in
 * the group it was last drawn in rather than dropping to "other" and back.
 */
export function groupOf(w: TmuxWindow, rules: readonly PrefixRule[], remembered?: ReadonlyMap<string, string>): string {
  if (w.group) return w.group;
  const name = w.name.toLowerCase();
  for (const r of rules) if (name.startsWith(r.prefix.toLowerCase())) return r.group;
  if (w.repo) return base(w.repo);
  if (w.repo === undefined && remembered?.has(w.id)) return remembered.get(w.id)!;
  return OTHER;
}

/** Group the strip's windows, in strip order. */
export function buildGroups(windows: readonly TmuxWindow[], rules: readonly PrefixRule[], remembered?: ReadonlyMap<string, string>): TabGroup[] {
  const byKey = new Map<string, TabGroup>();
  for (const w of windows) {
    const label = groupOf(w, rules, remembered);
    const key = label.toLowerCase();
    let g = byKey.get(key);
    if (!g) byKey.set(key, (g = { key, label, windows: [], marks: [], first: w.index }));
    g.windows.push(w);
    g.first = Math.min(g.first, w.index);
  }
  const groups = [...byKey.values()];
  for (const g of groups) {
    g.windows.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.index - b.index);
    g.status = worstStatus(g.windows.map((w) => w.status));
    g.marks = [...new Set(g.windows.map((w) => w.status).filter((s): s is WindowStatus => !!s && s !== "idle"))]
      .sort((a, b) => statusRank(a) - statusRank(b));
  }
  return groups.sort((a, b) => a.first - b.first);
}

/**
 * Whether the strip groups at all. One group is no grouping — a header over
 * every tab says nothing — so the strip stays flat until there are two.
 */
export function worthGrouping(groups: readonly TabGroup[]): boolean {
  return groups.length > 1;
}

/* ------------------------------------------------------------ preferences */

const ON_KEY = "agentglass.tabGroups";
const RULES_KEY = "agentglass.tabGroups.rules";
const OPEN_KEY = "agentglass.tabGroups.open";

const listeners = new Set<() => void>();
/** Bumped on every change, for `useSyncExternalStore`: the preferences are
 *  read fresh, and a counter is a snapshot that compares by value. */
let version = 0;
export const tabGroupsVersion = (): number => version;
const tell = () => { version++; for (const fn of listeners) fn(); };
export function subscribeTabGroups(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** On unless switched off: stored only when off. */
export function tabGroupsOn(): boolean {
  try { return localStorage.getItem(ON_KEY) !== "off"; } catch { return true; }
}
export function setTabGroupsOn(on: boolean): void {
  try { if (on) localStorage.removeItem(ON_KEY); else localStorage.setItem(ON_KEY, "off"); } catch { /* private mode */ }
  tell();
}

export function tabGroupRulesText(): string {
  try { return localStorage.getItem(RULES_KEY) ?? ""; } catch { return ""; }
}
export function setTabGroupRulesText(text: string): void {
  try { if (text.trim()) localStorage.setItem(RULES_KEY, text); else localStorage.removeItem(RULES_KEY); } catch { /* private mode */ }
  tell();
}

/**
 * Groups kept open beside the one you are in, per tmux session — Shift+click
 * on a chip. The group you are in is always open and is not stored.
 */
export function openGroups(session: string): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(OPEN_KEY) || "{}") as Record<string, unknown>;
    const list = all[session];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}
export function setOpenGroups(session: string, keys: ReadonlySet<string>): void {
  try {
    const all = JSON.parse(localStorage.getItem(OPEN_KEY) || "{}") as Record<string, unknown>;
    if (keys.size) all[session] = [...keys]; else delete all[session];
    localStorage.setItem(OPEN_KEY, JSON.stringify(all));
  } catch { /* private mode */ }
  tell();
}
