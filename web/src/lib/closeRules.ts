/*
 * Closing a window: when to ask, what to say, and how to put it back.
 *
 * Closing asks only when something would be lost that cannot be seen: an agent
 * that is working, or waiting on you, is stopped by the kill. A plain shell, an
 * idle agent, a finished one or a restored one closes at once, and the strip
 * offers a few seconds to take it back instead of a question nobody reads.
 * Reopening is honest about what it is: a plain shell in the same slot and the
 * same folder; the old process is gone.
 */
import type { TmuxWindow } from "../../../shared/types.ts";

export type CloseTarget = Pick<TmuxWindow, "id" | "name" | "status">;

export type CloseVerdict =
  | { ask: false }
  | { ask: true; title: string; body: string; stop: string };

const busy = (w: CloseTarget): boolean => w.status === "working" || w.status === "waiting";
const nameOf = (w: CloseTarget): string => w.name || "shell";

/** Whether closing these windows needs a question, and the words for it. */
export function closeVerdict(targets: readonly CloseTarget[], project?: string): CloseVerdict {
  const hot = targets.filter(busy);
  if (!hot.length) return { ask: false };
  if (targets.length === 1) {
    const w = targets[0]!;
    return {
      ask: true, title: `Close ${nameOf(w)}?`, stop: "Stop and close",
      body: `The agent is ${w.status === "waiting" ? "waiting on you" : "working"} and will be stopped.`,
    };
  }
  return {
    ask: true, stop: "Stop and close all",
    title: `Close ${targets.length} windows${project ? ` in ${project}` : ""}?`,
    body: hot.length === 1
      ? "1 has an agent that is working or waiting on you, and it will be stopped."
      : `${hot.length} have an agent that is working or waiting on you, and they will be stopped.`,
  };
}

/** The toast's sentence. */
export function closedSentence(targets: readonly CloseTarget[]): string {
  return targets.length === 1 ? `Closed ${nameOf(targets[0]!)}` : `Closed ${targets.length} windows`;
}

export interface ReopenStep {
  name: string;
  /** The folder the window was in, when tmux said. */
  cwd?: string;
  /** The window left standing next to the slot; absent when nothing is left. */
  anchor?: string;
  /** Land after the anchor (true) or before it (false). */
  after: boolean;
}

/**
 * Where each closed window goes back, in the order to ask the server.
 *
 * Next to the nearest window that stays: after the one before the slot, else
 * before the one after it. Inserting after the same anchor reverses what was
 * sent, so those are sent last-first and the row comes back in its old order.
 */
export function reopenPlan(all: readonly TmuxWindow[], ids: readonly string[]): ReopenStep[] {
  const gone = new Set(ids);
  const row = [...all].sort((a, b) => a.index - b.index);
  const closed = row.filter((w) => gone.has(w.id));
  if (!closed.length) return [];
  const first = row.indexOf(closed[0]!);
  const last = row.indexOf(closed[closed.length - 1]!);
  const before = row.slice(0, first).reverse().find((w) => !gone.has(w.id));
  const after = row.slice(last + 1).find((w) => !gone.has(w.id));
  const steps = closed.map((w) => ({
    name: nameOf(w), ...(w.cwd ? { cwd: w.cwd } : {}),
    ...(before ? { anchor: before.id, after: true } : after ? { anchor: after.id, after: false } : { after: true }),
  }));
  return before ? steps.reverse() : steps;
}
