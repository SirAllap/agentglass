/*
 * Quiet hours: a window in which the phone does not ring.
 *
 * Pure, because the one thing worth checking is the arithmetic across
 * midnight — 22:00 to 07:00 is the window people actually choose, and a
 * `from <= t && t < to` test for it is a window that never fires.
 *
 * "Let a stopped agent through" is the only exception: urgency 2 is the
 * server's word for something STOPPED and waiting on a person, which is the
 * one thing worth a buzz at 3 am. Everything else is held, and the Inbox still
 * fills — the alert is there when somebody looks, with the time it happened.
 */
export interface QuietPref {
  on: boolean;
  /** Minutes after midnight. */
  from: number;
  to: number;
  /** Let urgency 2 (a stopped agent) ring anyway. */
  agents: boolean;
}

/** Off by default, and here is why the mock shows it on: a phone that starts
 *  by silencing every night is a phone that decided, for somebody, before they
 *  had ever seen the setting — and the hours are the one preference whose
 *  effect depends on a clock rather than on a tap. Turned on, the window the
 *  sheet offers is 22:00 to 07:00. */
export const QUIET_DEFAULT: QuietPref = { on: false, from: 22 * 60, to: 7 * 60, agents: true };

/** The three values the sheet offers, as the mock draws them. */
export const FROM_CHOICES = [22 * 60, 23 * 60, 0] as const;
export const TO_CHOICES = [7 * 60, 6 * 60 + 30, 8 * 60] as const;

const cleanMinutes = (n: unknown): number | null =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 24 * 60 ? n : null;

/** Read what was stored, field by field, and never trust it. */
export function sanitizeQuiet(raw: unknown): QuietPref {
  if (!raw || typeof raw !== "object") return { ...QUIET_DEFAULT };
  const v = raw as Record<string, unknown>;
  return {
    on: typeof v.on === "boolean" ? v.on : QUIET_DEFAULT.on,
    from: cleanMinutes(v.from) ?? QUIET_DEFAULT.from,
    to: cleanMinutes(v.to) ?? QUIET_DEFAULT.to,
    agents: typeof v.agents === "boolean" ? v.agents : QUIET_DEFAULT.agents,
  };
}

/** "22:00". */
export function clockText(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "22:00 – 07:00", or "Off". The row's value, and the one place it is worded. */
export function quietText(p: QuietPref): string {
  return p.on ? `${clockText(p.from)} – ${clockText(p.to)}` : "Off";
}

/** Inside the window, midnight-crossing and same-day both. Start inclusive,
 *  end exclusive: 07:00 is when it rings again. */
export function inQuietWindow(p: QuietPref, at: Date): boolean {
  const t = at.getHours() * 60 + at.getMinutes();
  return p.from <= p.to ? t >= p.from && t < p.to : t >= p.from || t < p.to;
}

/**
 * Should this alert be held? `urgency` is the server's own scale; only 2 — a
 * thing STOPPED and waiting on a person — can pass, and only when the switch
 * says so.
 */
export function heldByQuiet(p: QuietPref, urgency: 0 | 1 | 2 | undefined, at: Date): boolean {
  if (!p.on) return false;
  if (p.agents && urgency === 2) return false;
  return inQuietWindow(p, at);
}

/** The next value in the mock's cycle, so a tap always changes something. */
export function cycle(current: number, choices: readonly number[]): number {
  const at = choices.indexOf(current);
  return choices[(at + 1) % choices.length] ?? (choices[0] ?? current);
}
