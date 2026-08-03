import type { ComponentType } from "react";
import type { ViewId } from "../../../../shared/types.ts";
import { GitIcon, DiffIcon, DockerIcon, TerminalIcon, ChatIcon, PrIcon, BrowserIcon, FilesIcon } from "./icons.tsx";
import { HAS_BROWSER } from "../../lib/desktop.ts";

/** Re-exported from shared so the server (POST /control validation) and the UI
 *  name one set of views. */
export type { ViewId };

export type ViewDef = {
  id: ViewId;
  label: string;
  /** Bare letter that jumps here. Kept identical to the old per-panel hotkeys
   *  so nobody has to relearn them. */
  key: string;
  icon: ComponentType<{ size?: number }>;
  hint: string;
};

/** Order is the rail's order, and ⌘1..⌘N index into it.
 *
 *  Browser is last, and conditional. Appending is the only place it could go
 *  without renumbering chords people already have in their fingers — and it is
 *  dropped entirely outside the desktop shell, where a `<webview>` does not
 *  exist. A rail entry that opens an empty pane on a phone would be worse than
 *  no entry at all. */
export const VIEWS: ViewDef[] = [
  { id: "git", label: "Git", key: "g", icon: GitIcon, hint: "Stage, commit, push/pull the working tree" },
  { id: "diff", label: "Diff", key: "d", icon: DiffIcon, hint: "Review & commit every diff the fleet made" },
  { id: "pr", label: "Pull requests", key: "p", icon: PrIcon, hint: "Review pull requests without leaving for the browser" },
  { id: "docker", label: "Docker", key: "o", icon: DockerIcon, hint: "Containers, logs, stats & actions" },
  { id: "term", label: "Term", key: "t", icon: TerminalIcon, hint: "A real shell in any repo/worktree" },
  { id: "chat", label: "Chat", key: "c", icon: ChatIcon, hint: "Drive a Claude session in any repo/worktree" },
  ...(HAS_BROWSER
    ? [{ id: "browser" as const, label: "Browser", key: "b", icon: BrowserIcon, hint: "A page, without leaving the app" }]
    : []),
  // Appended, for the same reason Browser was: ⌘1..⌘N index into this order,
  // and inserting anywhere above renumbers a chord somebody already has in
  // their fingers. Anyone who has ever dragged the rail gets it appended to
  // their own order regardless — loadViewOrder puts unknown views at the end —
  // so leading with it here would only have renumbered the people who never
  // touched it.
  { id: "files", label: "Files", key: "e", icon: FilesIcon, hint: "Browse and search a checkout — and open a file to edit" },
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
