/*
 * What the Terminal says about a window that is not running what it was.
 *
 * Two cases, and neither starts anything by itself:
 *   - restored: the desk was rebuilt after a reboot. The scrollback came back,
 *     the process did not. A banner says so once for the whole desk and a card
 *     in each window that was running an agent offers to resume it.
 *   - dead: the window's process exited and tmux kept the pane. A card offers
 *     a fresh shell in the same folder, or closing it.
 * The server decides which windows are which (shared/types.ts, TmuxWindow);
 * this only turns that into words.
 */
import type { TmuxWindow } from "../../../shared/types.ts";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export interface RestoredBanner {
  windows: number;
  agents: number;
  /** The restore these counts belong to; a dismissal is remembered against it. */
  stamp: number;
  text: string;
  /** Null when no window was running an agent. */
  resumeLabel: string | null;
}

export function restoredBanner(windows: readonly TmuxWindow[]): RestoredBanner | null {
  const back = windows.filter((w) => w.restored);
  if (!back.length) return null;
  const agents = back.filter((w) => w.was).length;
  const head = `Back after the reboot. ${plural(back.length, "window", "windows")} restored with their scrollback.`;
  const tail = agents === 0 ? ""
    : agents === 1 ? " 1 was running an agent; it is not running now."
    : ` ${agents} were running an agent; none of them is running now.`;
  return {
    windows: back.length, agents, stamp: Math.max(...back.map((w) => w.restoredAt ?? 0)),
    text: head + tail,
    resumeLabel: agents === 0 ? null : agents === 1 ? "Resume the agent" : `Resume the ${agents} agents`,
  };
}

/** "3 min", "2 h": how long ago, in the coarsest unit that is not zero. */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "a few seconds";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export type PaneCard =
  | { kind: "resume"; title: string; body: string; primary: string; secondary: string }
  | { kind: "dead"; title: string; body: string; primary: string; secondary: string };

/**
 * The card for a window, or null. A dead pane wins over a restored one: a
 * stale "was running" over a corpse would offer to resume what already failed.
 * `where` is the branch (or folder) the window stands in.
 */
export function paneCard(w: TmuxWindow, where: string | null, now: number): PaneCard | null {
  const name = w.name || "shell";
  if (w.dead) {
    const ago = w.diedAt ? `${name} stopped ${ageText(now - w.diedAt)} ago.` : `${name} stopped.`;
    return {
      kind: "dead", primary: "Restart here", secondary: "Close window",
      title: `This process exited with status ${w.exit ?? 0}`,
      body: `${ago} The text above is what it left. Restart opens a fresh shell in ${where ?? "the same folder"}.`,
    };
  }
  if (w.restored && w.was) {
    const spot = where ?? "the same folder";
    return {
      kind: "resume", primary: "Resume session", secondary: "Plain shell instead",
      title: `${name} was running ${w.was} before the reboot`,
      body: w.resume
        ? `The scrollback came back, the process did not. Resume continues session ${w.resume.slice(0, 8)} in ${spot}.`
        : `The scrollback came back, the process did not. Resume starts it again in ${spot}.`,
    };
  }
  return null;
}
