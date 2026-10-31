/*
 * What the "+" menu needs to decide, apart from drawing it.
 *
 * New agent has no server door that a desktop window may use (the server's
 * `agent` command answers a phone's attach and refuses anything else), so it
 * opens a window like "New shell" does and, when that window shows up in the
 * list tmux sends, types the agent's command at its prompt. "Shows up" is the
 * trigger rather than a timer: the first window id that was not there before.
 * The limit: it types into the new window's shell, so a shell that is slow to
 * start gets the line when it is ready, not before.
 */
import type { TmuxWindow } from "../../../shared/types.ts";
import { prefixByte } from "./prefixArmed.ts";

/** The first window in `now` whose id was not in `before`; null when none is new. */
export function appearedWindow(before: ReadonlySet<string>, now: readonly TmuxWindow[]): string | null {
  return now.find((w) => !before.has(w.id))?.id ?? null;
}

/** The command typed for "New agent". */
export const AGENT_COMMAND = "claude";

/**
 * "Split this window" under tmux: the prefix then tmux's own split binding,
 * as the bytes a keyboard would send. Null when the prefix is not one the page
 * can spell (then the item says so rather than typing something else).
 */
export function splitKeys(prefix: readonly string[]): string | null {
  for (const p of prefix) {
    const b = prefixByte(p);
    if (b) return `${b}%`;
  }
  return null;
}
