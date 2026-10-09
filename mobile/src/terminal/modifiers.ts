/*
 * Ctrl, Alt and Shift on a screen with nothing to hold down.
 *
 * ── why a latch and not a hold ───────────────────────────────────────────
 * A physical modifier is a key you keep pressed while you press another one.
 * A thumb cannot do that: there is one finger on the glass and it is the one
 * about to press the second key. Every terminal that has ever run on a phone
 * arrives at the same answer — the modifier is tapped, it waits, and the next
 * key press consumes it.
 *
 * ── why three states and not two ─────────────────────────────────────────
 * "Waits for one key" is the common case and it is what a single tap does.
 * It is the wrong answer for a combination pressed several times in a row,
 * and this app has one on screen: an agent's permission modes cycle on
 * Shift+Tab, so getting from one to the one after next is Shift, Tab, Shift,
 * Tab. Re-arming between every press is the kind of small tax that makes
 * somebody stop using the feature.
 *
 * So a second tap locks it until it is tapped off. The cycle is off → once →
 * locked → off, which is one control doing three things in the order a person
 * discovers them: the first tap is the thing they wanted, the second is the
 * thing they wanted after doing the first one twice.
 *
 * ── why the state is here and not in the screen ──────────────────────────
 * There is no renderer in this project. The rules — what a tap does, what
 * survives a key press, what a locked modifier does that a armed one does not
 * — are the part worth testing, and the failure mode of getting one wrong is a
 * bar that sends Ctrl+C when somebody meant to type a letter.
 */
import type { Modifier } from "./keys.ts";

/** One modifier's state. `once` is consumed by the next key; `locked` is not. */
export type Latch = "off" | "once" | "locked";

export type Latches = Readonly<Record<Modifier, Latch>>;

/** Nothing held.
 *
 *  Frozen for the reason DEFAULT_LAYOUT is frozen: a caller that assigned into
 *  this would be editing the starting state for the rest of the process, and a
 *  modifier that appears to arm itself is a bar that sends a control code into
 *  a command somebody was typing. */
export const NOTHING_HELD: Latches = Object.freeze({ ctrl: "off", alt: "off", shift: "off" });

/** Tapping one: off → once → locked → off. */
export function press(held: Latches, modifier: Modifier): Latches {
  const next: Latch = held[modifier] === "off" ? "once" : held[modifier] === "once" ? "locked" : "off";
  return { ...held, [modifier]: next };
}

/** What is on, in the order `keyBytes` documents its parameter in. Sorted so
 *  the same set of modifiers is always the same array — the encoding does not
 *  care, but a test comparing two of them does. */
export function armed(held: Latches): Modifier[] {
  return (["ctrl", "alt", "shift"] as const).filter((m) => held[m] !== "off");
}

export const anyHeld = (held: Latches): boolean => armed(held).length > 0;

/**
 * What is left after a key has been sent.
 *
 * Only `once` is spent. A locked modifier surviving is the whole of what
 * locking means, and it is why this is not simply NOTHING_HELD.
 */
export function afterSending(held: Latches): Latches {
  if (!armed(held).some((m) => held[m] === "once")) return held;
  return {
    ctrl: held.ctrl === "once" ? "off" : held.ctrl,
    alt: held.alt === "once" ? "off" : held.alt,
    shift: held.shift === "once" ? "off" : held.shift,
  };
}

/** For a screen reader, which needs to say the state and not just the key. */
export function spokenState(modifier: Modifier, latch: Latch): string {
  const name = modifier === "ctrl" ? "Control" : modifier === "alt" ? "Alt" : "Shift";
  if (latch === "locked") return `${name}, locked on`;
  if (latch === "once") return `${name}, on for the next key`;
  return `${name}, off`;
}

/**
 * The line above the bar while a modifier is waiting, in words.
 *
 * A colour change on a 48-point key is the only thing that used to say the next
 * press would be a control code, and it says it to somebody who already knows.
 * Null when nothing is held, so the line exists only while it is news.
 */
export function armedTip(held: Latches): string | null {
  const name = (m: Modifier): string => (m === "ctrl" ? "Ctrl" : m === "alt" ? "Alt" : "Shift");
  const list = (ms: Modifier[]): string => ms.map(name).join(" + ");
  const once = armed(held).filter((m) => held[m] === "once");
  const locked = armed(held).filter((m) => held[m] === "locked");
  const parts: string[] = [];
  if (once.length) parts.push(`${list(once)} ${once.length > 1 ? "are" : "is"} on for the next key`);
  if (locked.length) parts.push(`${list(locked)} ${locked.length > 1 ? "stay" : "stays"} on until you tap ${locked.length > 1 ? "them" : "it"} again`);
  if (!parts.length) return null;
  return `${parts.join("; ")}.${locked.length === 0 ? " Tap it again to keep it on." : ""}`;
}
