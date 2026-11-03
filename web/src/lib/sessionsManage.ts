/*
 * The Manage sessions dialog, as decisions: what each session holds, which can
 * be ended, which the "Clean up" button takes, and the sentence that asks.
 *
 * Ending a session takes everything running in it and there is no undo, so the
 * rules that keep a person from ending the wrong one live here where a test can
 * hold them: never the session the terminal is attached to (ending it detaches
 * the screen being read), never a locked one, and "Clean up" only takes sessions
 * that hold ONE window with nothing running in it.
 */
import type { AgentPane } from "../../../shared/types.ts";
import { worstStatus, type WindowStatus } from "../../../shared/windowStatus.ts";

export interface ManageSession { id: string; name: string; windows: number; locked?: boolean; /** Seconds since the epoch, when tmux made it. */ created?: number }
export interface SessionWindow { id: string; name: string; index: number; status?: WindowStatus }

/** Window names listed in a sentence before it says "+N more". */
export const NAMES_SHOWN = 4;

/** Every session's windows in tmux order, from the machine-wide pane list. A popup is a scratchpad, not a window of the session. */
export function windowsBySession(panes: readonly AgentPane[]): Map<string, SessionWindow[]> {
  const byWindow = new Map<string, AgentPane[]>();
  for (const p of panes) {
    if (p.popup) continue;
    const key = `${p.session}\u0000${p.windowId}`;
    const list = byWindow.get(key);
    if (list) list.push(p); else byWindow.set(key, [p]);
  }
  const out = new Map<string, SessionWindow[]>();
  for (const list of byWindow.values()) {
    const first = list[0]!;
    const w: SessionWindow = {
      id: first.windowId, name: first.windowName, index: Number(first.windowIndex) || 0,
      status: worstStatus(list.map((p) => p.status)),
    };
    const into = out.get(first.session);
    if (into) into.push(w); else out.set(first.session, [w]);
  }
  for (const list of out.values()) list.sort((a, b) => a.index - b.index);
  return out;
}

/** The current session is never endable and neither is a locked one. */
export const canEnd = (s: ManageSession, current: string): boolean => s.name !== current && s.locked !== true;

/** Why End is off, for its tooltip; null when it is on. */
export function endBlockedWhy(s: ManageSession, current: string): string | null {
  if (s.locked) return `${s.name} is protected — unlock it first`;
  if (s.name === current) return "Switch somewhere else first — ending the session you are on drops your terminal";
  return null;
}

const idle = (w: SessionWindow | undefined): boolean => !!w && (w.status === undefined || w.status === "idle");

/** Sessions the "Clean up" button ends: one window, nothing running in it, not locked, not the one you are on. */
export function cleanupTargets(sessions: readonly ManageSession[], current: string, by: ReadonlyMap<string, SessionWindow[]>): ManageSession[] {
  return sessions.filter((s) => {
    if (!canEnd(s, current) || s.windows !== 1) return false;
    const ws = by.get(s.name);
    return ws?.length === 1 && idle(ws[0]);
  });
}

export function namesText(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).map((n) => n || "shell");
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} +${more} more` : shown.join(", ");
}

/** "End <name>? Its N windows (a, b) stop. This can't be undone." */
export function endSentence(name: string, windows: number, names: readonly string[]): string {
  const holds = windows === 1 ? "Its 1 window" : `Its ${windows} windows`;
  const list = names.length ? ` (${namesText(names)})` : "";
  return `End ${name}? ${holds}${list} ${windows === 1 ? "stops" : "stop"}. This can't be undone.`;
}

/** The same question for Clean up, naming every session it would end. */
export function cleanupSentence(targets: readonly ManageSession[]): string {
  const n = targets.length;
  return `End ${n === 1 ? targets[0]!.name : `${n} sessions`}? ${n === 1 ? "It holds" : "Each holds"} one window with nothing running in it, none is locked. This can't be undone.`;
}

/** "2m old", "5h old", "3d old": the session's age at a glance; "" when tmux did not say. */
export function sessionAge(created: number | undefined, nowMs: number): string {
  if (!created) return "";
  const s = Math.max(0, Math.floor(nowMs / 1000 - created));
  if (s < 90) return "just now";
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m old`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h old`;
  return `${Math.floor(h / 24)}d old`;
}
