/*
 * An alarm the user set, as opposed to news about the fleet.
 *
 * Everything else behind the bell is something that HAPPENED and can be read
 * whenever: a branch fell behind, a tool failed, somebody commented on a card.
 * A reminder is different in kind — it is a promise made to yourself at a
 * particular minute, and one that arrives as the seventeenth grey row of the day
 * has failed at the only job it had.
 *
 * So it does not go in the list. It takes the screen, it makes a sound, and it
 * stays until it is answered — which is what "alarm" means everywhere else on a
 * machine, and what was asked for: "es una alarma que yo he programado, tiene
 * que ser más invasiva".
 *
 * Three deliberate limits:
 *
 *   · it rings for a MINUTE and then goes quiet, keeping the card on screen. A
 *     sound with no end is not more insistent, it is a reason to turn the
 *     feature off;
 *   · it ignores Quiet. Quiet is for other people's notifications — silencing
 *     your own alarm with the switch you flipped to mute Slack is a trap;
 *   · and the tone is generated, not a file. A strict CSP blocks a remote asset,
 *     a bundled one is 40kB for two seconds of sine, and neither survives being
 *     served from a different origin.
 */

import type { Reminder } from "../../../shared/types.ts";
import { ALARM_VOICES, findVoice, playVoice } from "./sounds.ts";

export type Alarm = {
  /** The reminder's id, so Done and Snooze act on the exact one. */
  id: string;
  title: string;
  /** What the notification said underneath — "in 15 minutes", the time it was
   *  set for. Shown because an alarm without its own time reads as a bug. */
  when: string;
  at: number;
};

let current: Alarm | null = null;
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };

export const alarmNow = (): Alarm | null => current;
export function subscribeAlarm(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/* ── the preference ───────────────────────────────────────────────────────── */

const VOICE_KEY = "agentglass.alarmVoice";

/** Which sound an alarm makes. "none" is a real answer — the card still takes
 *  the screen — and it is the only way to have a silent alarm without losing
 *  the alarm. */
export const alarmVoiceId = (): string => {
  try { return localStorage.getItem(VOICE_KEY) ?? ALARM_VOICES[0]!.id; } catch { return ALARM_VOICES[0]!.id; }
};

export function setAlarmVoice(id: string): void {
  try { localStorage.setItem(VOICE_KEY, id); } catch { /* private mode */ }
  if (id === "none") stopRinging();
}

/** Still asked by the card and by Settings: is this alarm going to make a noise
 *  at all. */
export const alarmSound = (): boolean => alarmVoiceId() !== "none";

/* ── raising and answering ────────────────────────────────────────────────── */

/**
 * Raise the alarm.
 *
 * Ignored when one is already up for the SAME reminder: the server re-announces
 * while a reminder is unacknowledged (that is the point — an alarm you slept
 * through should ask again), and each repeat must not restart the ringing on a
 * card the reader is already looking at.
 */
export function raiseAlarm(a: Alarm): void {
  if (current?.id === a.id) return;
  current = a;
  emit();
  if (alarmSound()) startRinging();
}

/** Take it down. The caller has already acknowledged or snoozed it — this is
 *  only the surface. */
export function clearAlarm(): void {
  if (!current) return;
  current = null;
  stopRinging();
  emit();
}

/**
 * The alarm for a reminder that fired while the app was closed.
 *
 * The fired-and-unacknowledged list is the server's, and it survives a restart —
 * so an alarm that went off at 09:00 with the app shut is still waiting at
 * 11:00, which is the honest behaviour: nobody set it in order to miss it.
 * Silent, though: ringing for something that happened two hours ago is a fright,
 * not a reminder.
 */
export function restoreAlarm(live: Reminder[]): void {
  if (current || !live.length) return;
  const r = live[0]!;
  current = { id: r.id, title: r.title, when: whenOf(r), at: r.firedAt ?? r.due };
  emit();
}

/** "09:00, an hour ago" — the time it was set for, and how long it has been
 *  waiting, because those are two different questions and both get asked. */
export function whenOf(r: Reminder): string {
  const clock = new Date(r.due).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const mins = Math.round((Date.now() - (r.firedAt ?? r.due)) / 60_000);
  if (mins < 2) return clock;
  if (mins < 60) return `${clock} · ${mins} min ago`;
  const h = Math.round(mins / 60);
  return `${clock} · ${h}h ago`;
}

/* ── the sound ────────────────────────────────────────────────────────────── */

/** How long it rings before it gives up and just sits there. */
const RING_MS = 60_000;
/** The gap between phrases. Long enough to be a clock rather than a siren. */
const EVERY_MS = 3_000;

let ringTimer: ReturnType<typeof setInterval> | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

function startRinging(): void {
  stopRinging();
  const voice = findVoice(ALARM_VOICES, alarmVoiceId());
  if (voice.id === "none") return;
  playVoice(voice);
  ringTimer = setInterval(() => playVoice(voice), EVERY_MS);
  stopTimer = setTimeout(stopRinging, RING_MS);
}

export function stopRinging(): void {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
}
