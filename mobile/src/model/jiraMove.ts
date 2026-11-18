/*
 * Moving a Jira card, decided before the sheet draws.
 *
 * A card has no status to set. The site offers transitions from where the card
 * stands, each leading to a status, and each may ask for fields. `GET
 * /jira/transitions` carries that screen (`JiraMove.fields`) and the server
 * checks it again on the way in; this module is the phone's half, so the button
 * is disabled and names the missing field instead of posting into a 400.
 *
 * ── the body is the transition's own fields ──────────────────────────────
 * `checkMoveFields` (shared/jiraMoveFields.ts) already refuses a key the move
 * does not ask for and drops blanks. Nothing here invents a field, and nothing
 * sends a value the move did not ask: a transition that asks for a reviewer
 * sends a reviewer, and one that asks for nothing sends `fields` absent.
 *
 * ── a move into Done holds ───────────────────────────────────────────────
 * Finishing a card is a write other people act on, and it fires the project's
 * own automations. It is in the hold table (model/confirmPolicy.ts,
 * `jira.done`), so the sheet draws a `HoldButton` for that target and a tap for
 * every other one — the decision is the table's, not this module's.
 */
import type { JiraMove, ProviderTask } from "../../../shared/providers.ts";
import { checkMoveFields, effectOf, type JiraMoveField, type MoveFieldsCheck } from "../../../shared/jiraMoveFields.ts";
import type { Answer } from "../lib/api.ts";

export interface JiraMovePlan {
  move: JiraMove | null;
  /** Would pressing do anything? */
  enabled: boolean;
  /** The button's words: "Move to In review", or the missing field's name. */
  label: string;
  /** One line under the button, saying why it is off. Null when it is on. */
  why: string | null;
  /** What the press does, in the order the site will do it. */
  effects: string[];
  /** The check the POST body is built from; null until a target is picked. */
  check: MoveFieldsCheck | null;
}

export const PICK_TARGET = "Choose where it moves";
export const PICK_TARGET_WHY = "Pick a target. Jira names the steps this card has from where it stands.";

/** The fields a move insists on, for the summary row above the form. */
export function requiredFields(move: JiraMove | null): JiraMoveField[] {
  return (move?.fields ?? []).filter((f) => f.required);
}

/** The transition ids the sheet offers. Everything the site said it has. */
export function moveChoices(moves: readonly JiraMove[]): JiraMove[] {
  return [...moves];
}

export function movePlan(key: string, from: string, move: JiraMove | null, values: unknown): JiraMovePlan {
  if (!move) {
    return { move: null, enabled: false, label: PICK_TARGET, why: PICK_TARGET_WHY, effects: [], check: null };
  }
  const check = checkMoveFields(move.fields ?? [], values);
  const effects = [`Moves ${key} from ${from || "its status"} to ${move.toStatus}`];
  for (const f of move.fields ?? []) {
    const line = effectOf(f, check.ok ? check.values[f.key] : undefined);
    if (line) effects.push(line);
  }
  if (!check.ok) {
    const bad = check.bad.map((k) => move.fields?.find((f) => f.key === k)).find((f): f is JiraMoveField => !!f);
    return {
      move, enabled: false,
      label: bad ? `Choose ${bad.name}` : "Fill the move in",
      why: check.error,
      effects, check,
    };
  }
  if (move.toStatus.trim().toLowerCase() === from.trim().toLowerCase()) {
    return { move, enabled: false, label: `Already in ${move.toStatus}`, why: "The card is already there.", effects, check };
  }
  return { move, enabled: true, label: `Move to ${move.toStatus}`, why: null, effects, check };
}

/**
 * The values the POST carries: the transition's own fields, filled ones only.
 * An unknown key is a mistake to name rather than something to send.
 */
export function moveValues(move: JiraMove, values: unknown): MoveFieldsCheck {
  return checkMoveFields(move.fields ?? [], values);
}

export type JiraMoveOutcome =
  | { kind: "moved"; task?: ProviderTask; was?: string }
  | { kind: "conflict" }
  | { kind: "failed"; text: string };

interface MoveAnswer { ok: boolean; error?: string; conflict?: boolean; task?: ProviderTask; was?: string }

/** What `POST /jira/transition` answered. A 409 is the server's own conflict;
 *  the flag is kept for a server that answers one with a 200. */
export function jiraMoveOutcome(answer: Answer<MoveAnswer>): JiraMoveOutcome {
  if (!answer.ok) return answer.status === 409 ? { kind: "conflict" } : { kind: "failed", text: answer.error };
  if (answer.value.ok) return { kind: "moved", task: answer.value.task, was: answer.value.was };
  if (answer.value.conflict) return { kind: "conflict" };
  return { kind: "failed", text: answer.value.error ?? "Jira refused that move." };
}
