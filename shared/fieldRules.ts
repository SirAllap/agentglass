/*
 * What a row on the Lantern's field IS, decided once for every reader.
 *
 * The server's watch, the CLI readout and the dashboard all look at the same
 * board and each needs to know which rows are dead names and which are claimed
 * work gone quiet. Twice a rule like this was written on one side and the
 * other side went on deciding for itself; living here, the watch that sends
 * the notification and the strip that shows the verdict cannot disagree about
 * who is stuck.
 */

/** The fields these rules read — a BoardRow on the server, a LanternRow here. */
export interface FieldRow {
  role?: string;
  paneId?: string;
  needsYou?: unknown;
  saidAt?: number;
  doing?: string;
  state?: "working" | "waiting" | "idle";
}

/**
 * A NAME THAT IS NOT SOMEBODY YOU CAN TALK TO.
 *
 * No pane this machine can see, AND quiet long enough that "it is between
 * panes" stops being the likely story. Both halves are required: a live agent
 * on a second tmux server has no pane here either, and it will have said
 * something in the last two hours.
 *
 * Exported because it had exactly one reader and needed two: the readout the
 * seat gets by CLI collapsed these, and the VIEW went on drawing all seventeen
 * — thirteen of them dead for a day or two. One rule, both screens.
 */
const COLD_MS = 2 * 60 * 60_000;
export const isGone = (r: FieldRow, now = Date.now()): boolean =>
  !r.paneId && !r.needsYou && (r.saidAt ?? 0) < now - COLD_MS;

/** How long a said-but-not-done agent may be quiet before it is "forgotten".
 *  An hour: shorter than that is a long tool call or a lunch, and the point
 *  of this kind is work that has sat since before you last looked. */
export const FORGOTTEN_AFTER_MS = 60 * 60_000;

/**
 * "Said what it was on, never said done, quiet for an hour" — finished and
 * nobody looked, or stuck and nobody noticed. A row the hooks made without a
 * status post has no `doing`, and an idle pane that never claimed a task is not
 * forgotten work — it is a shell. Neither is the Lantern's own chat or a seat
 * (`role`), nor a row stopped on a person, which is waiting, not forgotten.
 *
 * A DEAD SESSION IS NOT FORGOTTEN WORK.
 *
 * The shape of a session that ended two days ago is exactly the shape this
 * looks for: idle, with a `doing` from when it was alive, and quiet ever
 * since. So it was reported as forgotten work every single look, for ever
 * — and every one of those woke the seat. Measured from the other side, in
 * the seat's own words: six wakes in a night, five of them about sessions
 * dead for days, on the most expensive context on the machine.
 *
 * `isGone` is the rule the field and the view already share: no pane this
 * machine can see, AND quiet long enough that "it is between panes" has
 * stopped being the likely story. An agent quiet for an hour with no pane
 * here is still worth asking about — it may be alive on another tmux
 * server — which is why the two thresholds differ and why this is not just
 * a longer silence.
 */
export const isForgotten = <R extends FieldRow>(r: R, now = Date.now()): r is R & { doing: string; saidAt: number } =>
  !r.role && !r.needsYou && !isGone(r, now)
  && r.state === "idle" && !!r.doing && !!r.saidAt && now - r.saidAt >= FORGOTTEN_AFTER_MS;
