/*
 * Which controls on this phone hold, and which are taps.
 *
 * One table, because the alternative is a duration re-decided at every call
 * site — and the thing it protects is somebody's branch, somebody's merge or an
 * agent's command. A tap is the reversible half; the hold is the one that
 * writes on a repository, spends a worker or lets a command run.
 *
 * ── the gate rule, and why it is not a classifier ─────────────────────────
 * The phone does not read the command text. Every Allow holds, `ls` included:
 * a phone is not where a word list that decides "is this dangerous" should
 * live, because it would be wrong both ways and nobody would know until it was.
 * The server already treats release as the dangerous half (`mayReleaseAHold`),
 * so the phone holds the release.
 *
 * No renderer here: `settle` is the gesture as data — how long the finger was
 * down, and whether that was enough. The button in ui.tsx is the drawing.
 */
export const HOLD_MS = 1400;

/** What to say when a hold was let go too early. */
export const NOTHING_SENT = "Nothing was sent.";

export type ConfirmAction =
  | "gate.allow" | "gate.deny"
  | "pr.merge" | "pr.close" | "pr.reopen" | "pr.branch.update"
  | "pr.rerun" | "pr.labels" | "pr.reviewers" | "pr.draft" | "pr.edit"
  | "jira.done" | "jira.move" | "jira.comment" | "jira.assign" | "jira.link"
  | "plan.go" | "plan.nogo"
  | "window.kill"
  | "settings.answer";

/** The holds: every Allow, and the writes that cannot be taken back with a
 *  second tap — each one drawn as a HoldButton by the screen that does it.
 *  Everything else is a tap, including every "the safe direction" and every
 *  read. */
const HOLDS: ReadonlySet<ConfirmAction> = new Set<ConfirmAction>([
  "gate.allow",
  "pr.merge", "pr.close", "pr.reopen", "pr.branch.update",
  "jira.done",
  "plan.go",
  "window.kill",
]);

export function holdsToConfirm(action: ConfirmAction): boolean {
  return HOLDS.has(action);
}

export interface Settled {
  /** Did the gesture count? */
  decided: boolean;
  /** What to say when it did not — one line, and the same line everywhere. */
  said?: string;
}

/** What a finger that was down for `elapsedMs` has decided. A tap action is
 *  decided the moment it lifts; a hold is decided at `HOLD_MS` and not before. */
export function settle(action: ConfirmAction, elapsedMs: number): Settled {
  if (!holdsToConfirm(action) || elapsedMs >= HOLD_MS) return { decided: true };
  return { decided: false, said: NOTHING_SENT };
}
