/*
 * Whether an agent's open lands now or waits behind a chip.
 *
 * A quiet open (the default for any caller that names itself) must never move
 * the person out from under their hands. The measured trouble with the other
 * way is simple: a modal or a view switch arriving while somebody is typing
 * takes the keystrokes, and in a terminal that means a command typed into the
 * wrong place. So a quiet open that would change the view or draw a dialog is
 * held when the person is in a field or a terminal, or has just typed, and is
 * offered as a chip (components/AgentOffers.tsx) they click, or applied by
 * itself once they have been idle.
 *
 * Everything here is a function of its arguments so it can be tested alone; the
 * only state is the input clock at the bottom, which the window feeds.
 *
 * What this cannot do: stop a dialog's own autofocus once it is applied (a
 * modal that focuses its first field does so whether a click or the idle timer
 * brought it), and tell a person who is reading from one who left the room.
 * Both are why the idle apply waits as long as it does.
 */
import type { UiKind, UiPresent } from "../../../shared/uiActions.ts";

/** Typed (or clicked) this recently: the next keystroke is probably already on its way. */
export const TYPING_MS = 5_000;
/** A held open is applied by itself after this long with no input at all. */
export const IDLE_APPLY_MS = 45_000;
/** At most this many chips wait; a loop of opens must not grow a wall. */
export const MAX_OFFERS = 4;

export type FocusKind = "terminal" | "field" | "other";

/** The part of an element this needs, so a test hands it a plain object. */
export interface FocusEl {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  closest?: (sel: string) => unknown;
}

// An input that takes no typing (a checkbox you tabbed to) is not a field.
const NO_TEXT = new Set(["button", "checkbox", "radio", "range", "submit", "reset", "image", "file", "color"]);

/** Where the keyboard is: an xterm, a text field, or nothing that takes typing. */
export function focusKindOf(el: FocusEl | null | undefined): FocusKind {
  if (!el) return "other";
  if (typeof el.closest === "function" && el.closest(".xterm")) return "terminal";
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return "field";
  if (tag === "INPUT") return NO_TEXT.has((el.type ?? "text").toLowerCase()) ? "other" : "field";
  return el.isContentEditable ? "field" : "other";
}

export interface PresentInput {
  present: UiPresent;
  /** The registry entry's kind: only an `open` or a `stage` (a dialog put in front
   *  of the person) can be held. */
  kind: UiKind;
  /** The registry entry's `inPlace`: it closes or repaints, it moves nobody. */
  inPlace: boolean;
  focus: FocusKind;
  /** Milliseconds since the person last typed or clicked; Infinity if never. */
  sinceInputMs: number;
}

/**
 * `queue` only for a quiet open that would move the person while they are in a
 * field or a terminal or just typed. Everything else runs: `now` is the caller
 * saying the person asked, reads and settings changes show nothing to hold, and
 * an in-place door has nothing to land on.
 */
export function decidePresent(i: PresentInput): "apply" | "queue" {
  if (i.present === "now" || (i.kind !== "open" && i.kind !== "stage") || i.inPlace) return "apply";
  if (i.focus !== "other") return "queue";
  return i.sinceInputMs < TYPING_MS ? "queue" : "apply";
}

/** When a held open may apply itself: idle since the later of the last input and the hold. */
export function idleDueAt(lastInputAt: number | null, heldAt: number): number {
  return Math.max(lastInputAt ?? 0, heldAt) + IDLE_APPLY_MS;
}

// ── the chip's words ────────────────────────────────────────────────────────

/** The chip's sentence: who wants to show what. `as` is a label the caller chose. */
export const offerText = (as: string | undefined, label: string): string => `${as || "An agent"} wants to show you: ${label}`;

// ── the input clock ─────────────────────────────────────────────────────────

let lastInput: number | null = null;
/** The window calls this on keydown, pointerdown and paste. */
export function noteInput(at: number = Date.now()): void { lastInput = at; }
export const lastInputAt = (): number | null => lastInput;
export const sinceInputMs = (now: number = Date.now()): number => (lastInput === null ? Infinity : now - lastInput);
export function resetInputClock(): void { lastInput = null; }
