import type { UiReply } from "../../../shared/uiActions.ts";

/**
 * A command that asked for an answer reaches EVERY window (POST /control is a
 * broadcast) and the server settles on the first reply. A window nobody is
 * looking at waits a beat so a visible one gets there first; with only hidden
 * windows open (a headless renderer, a minimised app) the beat is all it costs.
 * No timer runs for a command that asked nothing.
 */
export const HIDDEN_ANSWER_DELAY_MS = 400;

export const answerDelayMs = (hidden: boolean): number => (hidden ? HIDDEN_ANSWER_DELAY_MS : 0);

export function answerControl(
  rid: string | undefined, reply: UiReply,
  post: (r: { rid: string } & UiReply) => Promise<unknown>, hidden: boolean,
): void {
  if (!rid) return;
  const wait = answerDelayMs(hidden);
  const send = () => { void post({ rid, ...reply }).catch(() => { /* the wait ran out, or another window answered */ }); };
  if (wait > 0) setTimeout(send, wait); else send();
}
