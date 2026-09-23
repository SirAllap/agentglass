/*
 * What the agent in a tmux window is doing, in the five words the tab strip,
 * the window switcher and a folded group's chip all use.
 *
 * The same vocabulary as the fleet's (`web/src/lib/derive.ts`), cut down to
 * what a tab has room to say. `stalled` is folded into `working` — a tab has
 * no room for the sentence that makes a stall arguable — and the fleet's
 * `failed` and `errored` are both `error` here: from the strip, "it went red"
 * is the whole message and the card says which kind.
 *
 * `unknown` is not in the list on purpose: a window with no agent in it has
 * no status at all (the field is absent), which is a different claim from an
 * agent that is idle.
 */
export type WindowStatus = "waiting" | "error" | "working" | "done" | "idle";

/**
 * Most urgent first. A window with several agent panes shows the most urgent of
 * them, and a folded group shows the most urgent of its windows — so a question
 * three panes deep, or in a group you are not looking at, still reaches you.
 */
export const STATUS_ORDER: readonly WindowStatus[] = ["waiting", "error", "working", "done", "idle"];

const RANK = new Map(STATUS_ORDER.map((s, i) => [s, i]));

/** Lower is more urgent; no status sorts after every status. */
export function statusRank(s: WindowStatus | null | undefined): number {
  return s ? (RANK.get(s) ?? STATUS_ORDER.length) : STATUS_ORDER.length;
}

/** The most urgent of several, or undefined when none of them has an agent. */
export function worstStatus(list: Iterable<WindowStatus | null | undefined>): WindowStatus | undefined {
  let best: WindowStatus | undefined;
  for (const s of list) if (s && statusRank(s) < statusRank(best)) best = s;
  return best;
}

/** How each status reads in a sentence — a tooltip, an aria-label. */
export const STATUS_WORDS: Record<WindowStatus, string> = {
  waiting: "waiting for you",
  error: "hit an error",
  working: "working",
  done: "finished",
  idle: "idle",
};
