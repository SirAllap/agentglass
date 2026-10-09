/*
 * The card's Status row, decided away from the screen.
 *
 * A status change is a write to a shared workspace: it fires the team's
 * automations and notifies people, and nothing here can take it back except
 * moving the card again. So the row is a sheet with a confirm button rather
 * than a chip that moves the card on touch, and these are the rules the screen
 * only draws:
 *
 *   - who may open the sheet at all, and what the lock says when they may not;
 *   - when the confirm button is live (only for a status the card is not in);
 *   - what the write's answer means, a 409 above all;
 *   - what the dialog says when somebody else got there first;
 *   - where "Undo" goes, and when it must not.
 *
 * The smaller thing this cannot do: name WHO moved the card. ClickUp's public
 * API carries no author for a status change (see CardEvent.who in
 * shared/providers.ts), so the dialog says "Somebody" and gives the time, which
 * is the card's own `updated`. A guess at a name would be an accusation.
 */
import type { ProviderTask } from "../../../shared/providers.ts";
import type { DeviceScope } from "../../../shared/types.ts";
import type { Answer } from "../lib/api.ts";

const readOnlyNote = (verb: string): string =>
  `This phone can read ClickUp but not change it. Pair again with full access to ${verb}.`;
export const READ_ONLY_PHONE = readOnlyNote("change the status");
/** One switch on the computer gates every field, so its note names none of them. */
export const WRITES_OFF =
  "Changing ClickUp is switched off on the computer. Switch it on there to change this card.";

export interface StatusAccess {
  can: boolean;
  /** Why not, for the note under the card; null when allowed, or not known yet. */
  why: string | null;
}

/**
 * May this phone change a field of the card? `verb` finishes the sentence that
 * tells a read-only phone what pairing again would buy it.
 *
 * `full` is the server's own rule for a write; `writeEnabled` is the
 * computer's switch for ClickUp in particular, read from `/clickup/views`.
 * `null` is "not read yet": not allowed, and not a reason either, so the row
 * waits quietly instead of flashing a lock at somebody who is allowed.
 */
export function fieldAccess(
  scope: DeviceScope | null | undefined, writeEnabled: boolean | null | undefined, verb: string,
): StatusAccess {
  if (scope !== "full") return { can: false, why: readOnlyNote(verb) };
  if (writeEnabled === false) return { can: false, why: WRITES_OFF };
  if (writeEnabled !== true) return { can: false, why: null };
  return { can: true, why: null };
}

/** May this phone change the status? */
export const statusAccess = (scope: DeviceScope | null | undefined, writeEnabled: boolean | null | undefined): StatusAccess =>
  fieldAccess(scope, writeEnabled, "change the status");

/** May this phone comment? The same switch as every other write to the card. */
export const commentAccess = (scope: DeviceScope | null | undefined, writeEnabled: boolean | null | undefined): StatusAccess =>
  fieldAccess(scope, writeEnabled, "comment");

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The confirm button: what it says, and whether pressing it would do anything. */
export function moveLabel(current: string, choice: string | null): { label: string; enabled: boolean } {
  if (!choice || same(current, choice)) return { label: "Pick another status", enabled: false };
  return { label: `Move to ${choice}`, enabled: true };
}

/** The workspace's colour, with a floor: some boards pick a status colour that
 *  is legible on their own white background and vanishes on this one. */
export const statusInk = (color?: string): string | undefined => (color && color !== "#ffffff" ? color : undefined);

export interface StatusChoice { status: string; color?: string; current: boolean }

/** Every status the list accepts, in its own order, the card's own tagged. */
export function statusChoices(
  statuses: readonly { status: string; color?: string }[],
  current: string,
): StatusChoice[] {
  return statuses
    .filter((s) => s.status)
    .map((s) => ({ status: s.status, color: s.color, current: same(s.status, current) }));
}

export type MoveOutcome =
  | { kind: "moved"; task?: ProviderTask }
  | { kind: "conflict" }
  | { kind: "failed"; text: string };

interface MoveBody { ok: boolean; error?: string; conflict?: boolean; task?: ProviderTask }

/**
 * What `/clickup/status` answered.
 *
 * The server sends a conflict as HTTP 409, and the phone's `ask` turns every
 * non-2xx into a failed Answer, so the `conflict` flag in the body never
 * reaches the screen on the wire. The status is what says it; the flag is kept
 * for a server that answers a conflict with a 200.
 */
export function moveOutcome(answer: Answer<MoveBody>): MoveOutcome {
  if (!answer.ok) return answer.status === 409 ? { kind: "conflict" } : { kind: "failed", text: answer.error };
  if (answer.value.ok) return { kind: "moved", task: answer.value.task };
  if (answer.value.conflict) return { kind: "conflict" };
  return { kind: "failed", text: answer.value.error ?? "The board refused that." };
}

export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

export interface ConflictDialog {
  text: string;
  /** The primary button: leave the card as the other person made it. */
  keep: string;
  /** The secondary button; null when the card is already where it was going. */
  overwrite: string | null;
}

/**
 * What to say when the card changed between opening it and moving it.
 *
 * `theirs` is the card re-read after the refusal, `opened` the status the
 * screen had when it was opened. A change that left the status alone (a
 * comment count, a due date) is called a change: saying "moved" would be a
 * claim about the board that nobody checked.
 */
export function conflictDialog(a: { theirs: ProviderTask; opened: string; wanted: string; now: number }): ConflictDialog {
  const when = ago(a.theirs.updated, a.now);
  const keep = `Keep ${a.theirs.status}`;
  if (same(a.theirs.status, a.wanted)) {
    return { text: `Somebody already moved this to ${a.theirs.status} ${when}.`, keep, overwrite: null };
  }
  const moved = !same(a.theirs.status, a.opened);
  return {
    text: moved
      ? `Somebody moved this to ${a.theirs.status} ${when}. Moving it now would overwrite that.`
      : `Somebody changed this card ${when}. Moving it now is still possible.`,
    keep,
    overwrite: `Move to ${a.wanted} anyway`,
  };
}

/**
 * Where "Undo" sends the card: back to where it was, but only while it is
 * still where the move left it. Once somebody else moved it again, undoing
 * would overwrite them with a status from before they acted.
 */
export function undoTarget(moved: { from: string; to: string } | null, now: string): string | null {
  if (!moved || same(moved.from, moved.to)) return null;
  return same(moved.to, now) ? moved.from : null;
}
