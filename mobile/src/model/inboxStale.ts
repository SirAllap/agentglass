/*
 * When an Inbox card is no longer the person's to answer.
 *
 * A settings request or a flight-plan decision can be answered somewhere else
 * — the desk, another phone — or expire on its own. The phone must not keep a
 * card with Approve and Decline on it for a question nobody is asking any
 * more: a press on it can only fail, and the failure reads as the app broken.
 *
 * Three ways the phone learns it, and all three are decided here so a test can
 * hold them without a renderer (mobile/test/inbox-stale.test.ts):
 *
 *   1. the server's push: `/stream` sends `{type:"settings-requests"}` or
 *      `{type:"flight-plan"}` whenever either list changes, so the Inbox reads
 *      again on that frame instead of waiting for its minute;
 *   2. the answer to a press: the server says the request is gone (404) or the
 *      plan was already decided (409, "a go plan cannot be told Go");
 *   3. the clock: a settings request the server declines at `expires` is gone
 *      at `expires`, so the list is drawn again at that moment.
 */
import type { WsFrame } from "../../../shared/types.ts";
import type { Answer } from "../lib/api.ts";

/** A frame that says the settings requests or the flight plans changed. */
export function refreshesInbox(frame: Pick<WsFrame, "type">): boolean {
  return frame.type === "settings-requests" || frame.type === "flight-plan";
}

/**
 * The press found nothing to answer: somebody else, or the expiry, got there
 * first. The card should leave, not stay with an error under it.
 *
 * A refusal that is NOT this — a phone paired to look only (403), a route that
 * did not answer — keeps the card: the question is still open.
 */
export function answerGone(source: "settings" | "plans", answer: Answer<unknown>): boolean {
  if (answer.ok) return false;
  if (answer.status === 404) return true;
  return source === "plans" && answer.status === 409 && /plan cannot be told/.test(answer.error);
}

/** Milliseconds until the next waiting request expires, or null when none
 *  will. The Inbox draws itself again then, so a countdown never outlives the
 *  request it counts. */
export function nextExpiryIn(list: readonly { expires: number }[], now = Date.now()): number | null {
  let soonest: number | null = null;
  for (const r of list) {
    if (r.expires > now && (soonest === null || r.expires < soonest)) soonest = r.expires;
  }
  return soonest === null ? null : soonest - now;
}
