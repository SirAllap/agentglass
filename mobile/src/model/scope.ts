/*
 * What a pairing's scope lets the phone offer.
 *
 * The server decides what a device MAY do (server/src/auth.ts: `scopeNeeded`,
 * `FULL_GET`) and the phone decides what it SHOWS. The two used to disagree
 * about the terminal: `/terminal/pty` needs `full`, and the Terminal tab was in
 * every Inbox and behind every hand-off regardless — so a phone paired for
 * `read` opened a pane, watched the socket drop, and was told the connection
 * had been lost, which is not what happened. The connection was refused, for a
 * reason the phone already knew.
 *
 * One function for the places that decide whether the terminal may open at
 * all — the Terminal screen, and the issue detail's "send to an agent". The
 * three hand-offs that end in the terminal (a review, an issue, a card) sit
 * behind their screens' own `mayWrite`, which is the same test spelled where
 * the screen's other writes already read it.
 */
import type { DeviceScope } from "../../../shared/types.ts";

/**
 * May this phone open a terminal or hand work to an agent?
 *
 * Both are the same act as far as the server is concerned — a shell on the
 * machine — and both need `full`. `answer` may approve a held command and
 * `read` may look, and neither may type.
 */
export const canRunAgents = (scope: DeviceScope | null | undefined): boolean => scope === "full";

/**
 * May this phone answer a held command or a settings request?
 *
 * `answer` exists for exactly those two acts (`server/src/auth.ts`, ANSWER_POST)
 * and `full` includes it. The Inbox draws its answer controls at this level and
 * says why when it may not, rather than posting into a 403.
 */
export const canAnswer = (scope: DeviceScope | null | undefined): boolean =>
  scope === "answer" || scope === "full";
