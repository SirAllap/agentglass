/*
 * Which alerts are worth a buzz, and which are the same alert twice.
 *
 * Pure and separate from the raising, because the decision is the whole
 * feature. A companion that notifies too much is one people silence, and a
 * silenced companion is worse than no companion — it is a thing you believe is
 * watching for you while it is not.
 *
 * The alerts themselves come from the server, unchanged: `{type:"alert"}` on
 * the live socket is exactly what it hands to `notify-send` on the desk. So
 * nothing here decides what is INTERESTING — the server already did — only
 * what is worth interrupting somebody who is not at the desk.
 */
import type { AlertNote, PrTalkNote } from "../../../shared/types.ts";
import { talkBody, talkSummary } from "../../../shared/talkWords.ts";
import type { TalkPref } from "./talkPref.ts";

/**
 * How long two identical alerts count as one.
 *
 * The reason this used to give was that the server re-broadcasts on reconnect,
 * so a phone coming out of a pocket would buzz once per lift door. GREPPED, and
 * it is not true: `{type:"alert"}` has exactly one producer, `index.ts:502`,
 * reached only from `deliver()` at the moment an alert happens. What the socket
 * sends a client that attaches is `{type:"initial"}` — events, not alerts. A
 * reconnect replays nothing.
 *
 * What it really guards is the server having no dedupe of its own: `deliver()`
 * broadcasts per qualifying event, so an agent that stops for approval twice on
 * the same session sends the same title and body twice, and two buzzes for one
 * situation is how a channel gets switched off in Android's settings — where
 * this app cannot see it and cannot ask again.
 */
export const SAME_ALERT_MS = 90_000;

export interface NotifyContext {
  /** The app is open and on screen. */
  foreground: boolean;
  /** When an alert with this exact text last raised a notification. */
  lastSeen: Map<string, number>;
  now: number;
  /** Which computer it came from. The same words from two computers are two
   *  alerts, so the window is per computer; absent means "the only one". */
  hostId?: string;
}

/** What makes two alerts the same one. Title and body, because urgency can be
 *  re-evaluated by the server between broadcasts of the same event. `Pick`
 *  rather than the full shape: `shouldNotifyTalk` below builds one of these
 *  just to compute this key, from a note that carries no urgency, pane or
 *  reminder id. */
export const alertKey = (alert: Pick<AlertNote, "title" | "body">, hostId = ""): string =>
  `${hostId}\0${alert.title}\0${alert.body}`;

export type Verdict =
  | { notify: true }
  | { notify: false; because: "foreground" | "repeat" | "low" | "empty" | "redraw" };

/**
 * Should this one buzz?
 *
 * Four reasons not to, and each is a different kind of no:
 *
 *   * `foreground` — you are looking at the app. The queue is already on
 *     screen and updating; a notification over the top of it is the app
 *     telling you what you can see.
 *   * `repeat` — the same alert inside the window. The server broadcasts per
 *     event and dedupes nothing, so one situation can arrive twice.
 *   * `low` — urgency 0 is the server's own "worth knowing, not worth
 *     stopping for". A phone is the wrong place for those: it is the one
 *     screen where every interruption costs attention somewhere else.
 *   * `empty` — nothing to show. A notification with no title is a buzz with
 *     no explanation, which teaches people to ignore the next one.
 *   * `redraw` — a keyed card being updated in place or removed (the
 *     Lantern's, when the set it lists changes with nothing new in it). The
 *     desk redraws a row; there is no news for a pocket.
 */
export function shouldNotify(alert: AlertNote, ctx: NotifyContext): Verdict {
  if (!alert || !alert.title?.trim()) return { notify: false, because: "empty" };
  if (alert.update || alert.clear) return { notify: false, because: "redraw" };
  if (ctx.foreground) return { notify: false, because: "foreground" };
  if ((alert.urgency ?? 1) < 1) return { notify: false, because: "low" };

  const seen = ctx.lastSeen.get(alertKey(alert, ctx.hostId));
  if (seen !== undefined && ctx.now - seen < SAME_ALERT_MS) return { notify: false, because: "repeat" };

  return { notify: true };
}

export type TalkVerdict =
  | { notify: true }
  | { notify: false; because: "off" | "pref-mismatch" | "foreground" | "repeat" };

/**
 * Should a new pull-request remark buzz THIS phone?
 *
 * A separate function from `shouldNotify` rather than a case inside it,
 * because the gates are different in kind: `shouldNotify` reads what the
 * SERVER decided (urgency, update/clear); this one starts from a per-device
 * PREFERENCE the server never sees (see talkPref.ts — there is no
 * `NotifyKind` for this).
 *
 *   * `off` — the preference itself. The live tick still moves regardless
 *     (host-context.tsx calls `noteTalk` before ever asking this), so the
 *     badge and an open pane still refresh; only the system notification is
 *     gated here.
 *   * `pref-mismatch` — set to "reviews" and this is a plain comment. The
 *     mirror image, a comment-only preference, does not exist: nobody would
 *     ask to hear about a review's line comments and not its verdict.
 *   * `foreground` — the app is already on screen; a notification over live,
 *     updating content is the app telling you what you can see.
 *   * `repeat` — the same remark inside `SAME_ALERT_MS`, keyed the same way
 *     `shouldNotify` keys a server alert: by the words it would show. `talk`
 *     has no update/clear frames re-announcing an unmoving fact, so those two
 *     of `shouldNotify`'s reasons have nothing to gate here.
 */
export function shouldNotifyTalk(
  note: PrTalkNote,
  ctx: { pref: TalkPref; foreground: boolean; lastSeen: Map<string, number>; now: number; hostId?: string },
): TalkVerdict {
  if (ctx.pref === "off") return { notify: false, because: "off" };
  if (ctx.pref === "reviews" && note.kind !== "review") return { notify: false, because: "pref-mismatch" };
  if (ctx.foreground) return { notify: false, because: "foreground" };

  const key = alertKey({ title: talkSummary(note), body: talkBody(note) }, ctx.hostId);
  const seen = ctx.lastSeen.get(key);
  if (seen !== undefined && ctx.now - seen < SAME_ALERT_MS) return { notify: false, because: "repeat" };

  return { notify: true };
}

/**
 * Android's importance for an alert, by the server's urgency.
 *
 * Only urgency 2 gets `max` — that is the level that puts a banner over
 * whatever you are doing, and the server reserves 2 for something that is
 * STOPPED and waiting on a person. Making everything urgent is how a channel
 * gets turned off in the system settings, where the app cannot see it and
 * cannot ask again.
 */
export function importanceOf(urgency: 0 | 1 | 2 | undefined): "max" | "high" | "default" {
  return urgency === 2 ? "max" : urgency === 1 ? "high" : "default";
}

/**
 * Remember that this one buzzed, and forget the ones that have aged out so the
 * map cannot grow for the lifetime of the process.
 *
 * Returns the way back, and that is the whole point of the shape.
 *
 * The window has to open BEFORE the raise is awaited, because `raise` is async
 * and two identical alerts arriving inside that await would both find nothing
 * in the map and both buzz — the exact duplicate this window exists to stop,
 * moved from the reconnect that never happened to a real race. But a delivery
 * that fails must not consume the window either, or a phone whose channel is
 * switched off in Android's settings goes quiet for ninety seconds per alert
 * for a notification it never drew.
 *
 * So: set it, and hand back an undo for the caller to run if the raise says no.
 * Restoring the PREVIOUS timestamp rather than deleting the key — an earlier
 * delivery of the same alert has its own live window, and deleting would let
 * that one buzz again.
 */
export function remember(alert: Pick<AlertNote, "title" | "body">, ctx: Pick<NotifyContext, "lastSeen" | "now" | "hostId">): () => void {
  const key = alertKey(alert, ctx.hostId);
  const before = ctx.lastSeen.get(key);
  ctx.lastSeen.set(key, ctx.now);
  for (const [k, at] of ctx.lastSeen) {
    if (ctx.now - at > SAME_ALERT_MS * 4) ctx.lastSeen.delete(k);
  }
  return () => {
    if (before === undefined) ctx.lastSeen.delete(key);
    else ctx.lastSeen.set(key, before);
  };
}
