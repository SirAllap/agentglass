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
import { agentProvider } from "../../../shared/agentKinds.ts";
import { prefixByte } from "./prefixArmed.ts";

/** The first window in `now` whose id was not in `before`; null when none is new. */
export function appearedWindow(before: ReadonlySet<string>, now: readonly TmuxWindow[]): string | null {
  return now.find((w) => !before.has(w.id))?.id ?? null;
}

/** The command typed for "New agent": the agent step 1 picked, by its CLI name. */
let picked = "claude";

/** Remember the picked agent (an engine id). Anything else leaves it alone. */
export function notePickedAgent(id: string | null | undefined): void {
  if (id && agentProvider(id)) picked = id;
}

/** Which agent "New agent" starts. */
export const pickedAgent = (): string => picked;

export const agentCommand = (): string => agentProvider(picked)?.bin ?? "claude";

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
