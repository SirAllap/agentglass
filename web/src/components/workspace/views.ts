import type { ComponentType } from "react";
import { GitIcon, DiffIcon, DockerIcon, TerminalIcon, ChatIcon } from "./icons.tsx";

export type ViewId = "git" | "diff" | "docker" | "term" | "chat";

export type ViewDef = {
  id: ViewId;
  label: string;
  /** Bare letter that jumps here. Kept identical to the old per-panel hotkeys
   *  so nobody has to relearn them. */
  key: string;
  icon: ComponentType<{ size?: number }>;
  hint: string;
};

/** Order is the rail's order, and ⌘1..⌘5 index into it. */
export const VIEWS: ViewDef[] = [
  { id: "git", label: "git", key: "g", icon: GitIcon, hint: "stage, commit, push/pull the working tree" },
  { id: "diff", label: "diff", key: "d", icon: DiffIcon, hint: "review & commit every diff the fleet made" },
  { id: "docker", label: "docker", key: "o", icon: DockerIcon, hint: "containers, logs, stats & actions" },
  { id: "term", label: "term", key: "t", icon: TerminalIcon, hint: "a real shell in any repo/worktree" },
  { id: "chat", label: "chat", key: "c", icon: ChatIcon, hint: "drive a Claude session in any repo/worktree" },
];

export const VIEW_IDS = VIEWS.map((v) => v.id);

/** "g" -> "git". Used by the global keydown handler. */
export const LETTER_TO_VIEW: Record<string, ViewId> = Object.fromEntries(
  VIEWS.map((v) => [v.key, v.id]),
);

export const isViewId = (v: unknown): v is ViewId => VIEW_IDS.includes(v as ViewId);

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
