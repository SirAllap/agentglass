import type { ComponentType } from "react";
import { GitIcon, DiffIcon, DockerIcon, TerminalIcon, ChatIcon, PrIcon } from "./icons.tsx";

export type ViewId = "git" | "diff" | "pr" | "docker" | "term" | "chat";

export type ViewDef = {
  id: ViewId;
  label: string;
  /** Bare letter that jumps here. Kept identical to the old per-panel hotkeys
   *  so nobody has to relearn them. */
  key: string;
  icon: ComponentType<{ size?: number }>;
  hint: string;
};

/** Order is the rail's order, and ⌘1..⌘6 index into it. */
export const VIEWS: ViewDef[] = [
  { id: "git", label: "Git", key: "g", icon: GitIcon, hint: "Stage, commit, push/pull the working tree" },
  { id: "diff", label: "Diff", key: "d", icon: DiffIcon, hint: "Review & commit every diff the fleet made" },
  { id: "pr", label: "Pull requests", key: "p", icon: PrIcon, hint: "Review pull requests without leaving for the browser" },
  { id: "docker", label: "Docker", key: "o", icon: DockerIcon, hint: "Containers, logs, stats & actions" },
  { id: "term", label: "Term", key: "t", icon: TerminalIcon, hint: "A real shell in any repo/worktree" },
  { id: "chat", label: "Chat", key: "c", icon: ChatIcon, hint: "Drive a Claude session in any repo/worktree" },
];

export const VIEW_IDS = VIEWS.map((v) => v.id);

/** "g" -> "git". Used by the global keydown handler. */
export const LETTER_TO_VIEW: Record<string, ViewId> = Object.fromEntries(
  VIEWS.map((v) => [v.key, v.id]),
);

export const isViewId = (v: unknown): v is ViewId => VIEW_IDS.includes(v as ViewId);

const ORDER_KEY = "agentglass.workspace.order";

/**
 * The rail's order, as the user arranged it.
 *
 * Shipped order is one opinion about which view you reach for most, and it is
 * wrong for anyone whose day is shaped differently — someone living in the
 * terminal wants it under their thumb, not third from the top. Stored as ids
 * and merged over the shipped list, so a view added in a later version appears
 * rather than being silently dropped by an older saved order.
 */
/**
 * Cached, and it has to be.
 *
 * This is the getSnapshot for a useSyncExternalStore, which compares snapshots
 * by identity — returning a freshly built array on every call means every
 * render reports a change, which loops until React gives up and renders
 * nothing. A blank workspace, seconds after a drag. The same note is on
 * liveSessionCount for the same reason; it is the standard way to get this
 * wrong.
 */
let cachedOrder: ViewDef[] | null = null;

export function loadViewOrder(): ViewDef[] {
  if (cachedOrder) return cachedOrder;
  let saved: unknown = null;
  try { saved = JSON.parse(localStorage.getItem(ORDER_KEY) || "null"); } catch { /* absent or corrupt */ }
  if (!Array.isArray(saved)) { cachedOrder = VIEWS; return cachedOrder; }
  const byId = new Map(VIEWS.map((v) => [v.id, v]));
  const out: ViewDef[] = [];
  for (const id of saved) {
    const v = byId.get(id as ViewId);
    if (v && !out.includes(v)) out.push(v);
  }
  for (const v of VIEWS) if (!out.includes(v)) out.push(v);
  cachedOrder = out;
  return cachedOrder;
}

export function saveViewOrder(ids: ViewId[]) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); } catch { /* non-fatal */ }
  cachedOrder = null; // rebuilt on the next read, once, and stable again after

  for (const fn of orderListeners) fn();
}

const orderListeners = new Set<() => void>();
export function subscribeViewOrder(fn: () => void): () => void {
  orderListeners.add(fn);
  return () => { orderListeners.delete(fn); };
}

const LAST_VIEW_KEY = "agentglass.workspace.view";

/** The workspace reopens where you left it — switching views is the common
 *  action, so the last one is a far better guess than a fixed default. */
export function loadLastView(): ViewId {
  try {
    const v = localStorage.getItem(LAST_VIEW_KEY);
    if (isViewId(v)) return v;
  } catch { /* private mode / disabled storage */ }
  return "git";
}

export function saveLastView(v: ViewId) {
  try { localStorage.setItem(LAST_VIEW_KEY, v); } catch { /* non-fatal */ }
}
