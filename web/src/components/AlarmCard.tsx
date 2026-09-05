/*
 * The alarm, on screen.
 *
 * Not a toast and not a row behind the bell: a card the app puts in front of
 * whatever you were doing, with the three answers an alarm has — I did it, ask
 * me again shortly, take me to it.
 *
 * It is deliberately NOT a modal with a scrim. An alarm interrupts; it does not
 * seize. Blocking the whole window would mean an alarm that goes off mid-command
 * eats the keystroke you were typing, and the one thing worse than a reminder
 * you miss is one that costs you the work you were doing when it arrived. So it
 * takes the top-right corner, over everything, and waits.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { alarmNow, clearAlarm, restoreAlarm, stopRinging, subscribeAlarm } from "../lib/alarm.ts";
import { api } from "../lib/api.ts";
import { liveReminders, nudgeReminders, subscribeReminders } from "../lib/reminderStore.ts";
import { LAYER } from "../lib/layers.ts";
import { CloseButton } from "./CloseButton.tsx";
import { ICON } from "../lib/iconSize.ts";

/** How long "later" is. Ten minutes is the snooze every clock on earth defaults
 *  to, and a number nobody has to think about is the right one here. */
const SNOOZE_MIN = 10;

export function AlarmCard(
  { onOpenTasks, onOpenDeputy }: { onOpenTasks?: () => void; onOpenDeputy?: () => void },
) {
  const alarm = useSyncExternalStore(subscribeAlarm, alarmNow, alarmNow);
  /* Subscribing to the reminders as well, for the alarm that fired while the app
     was CLOSED. The fired-and-unanswered list is the server's and survives a
     restart, so a 09:00 alarm is still waiting at 11:00 — nobody set it in order
     to miss it. Silently, though: see `restoreAlarm`. */
  const live = useSyncExternalStore(subscribeReminders, liveReminders, liveReminders);
  useEffect(() => { restoreAlarm(live); }, [live]);
  const [busy, setBusy] = useState(false);

  /* Escape silences the sound without answering the alarm. Two separate things:
     "stop making noise, I have seen it" is not "I have done it", and a card that
     vanished on Escape would be a reminder dismissed by the reflex that closes
     every other overlay in the app. */
  useEffect(() => {
    if (!alarm) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") stopRinging(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [alarm]);

  if (!alarm) return null;

  const deputy = alarm.kind === "deputy";

  const answer = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch { /* the card stays up; the reminder is still live */ }
    await nudgeReminders().catch(() => { /* the poll will catch up */ });
    setBusy(false);
    clearAlarm();
  };

  return (
    <div
      role="alertdialog" aria-live="assertive"
      aria-label={`${deputy ? "Clone" : "Reminder"}: ${alarm.title}`}
      className="fixed rounded-xl overflow-hidden"
      style={{
        top: 56, right: 16, width: 340, zIndex: LAYER.alarm,
        background: "var(--bg2)",
        border: "1px solid color-mix(in srgb, var(--warning) 55%, transparent)",
        boxShadow: "0 24px 60px -18px rgba(0,0,0,0.75)",
      }}
    >
      {/* A stripe rather than a tinted card: the alarm has to be recognisable
          from the corner of the eye without making its own text harder to read
          than every other surface. */}
      <div style={{ height: 3, background: "var(--warning)" }} />

      <div className="p-3.5 flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <span aria-hidden style={{ color: "var(--warning)", fontSize: ICON.md, lineHeight: 1 }}>{deputy ? "🙋" : "⏰"}</span>
          <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--warning)" }}>{deputy ? "Clone" : "Reminder"}</span>
          <span className="text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>{alarm.when}</span>
          {/* Closing the card is not answering it: the reminder stays live and
              the list still shows it. Anything else would make the reflex that
              dismisses a toast delete a promise. */}
          <CloseButton onClick={clearAlarm} title="Hide this — the reminder stays" className="ml-auto shrink-0" />
        </div>

        <p className="text-[13px] leading-snug" style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{alarm.title}</p>

        {/*
          * THE DEPUTY IS NOT A REMINDER, and every control here was a
          * reminder's. `Done` called `reminderAck` with an id no reminder has,
          * `Snooze` was meaningless for a machine that is stopped, and "Open
          * the task →" went to a ClickUp card. Three reports, the last of them
          * "Que cojones".
          *
          * What it needs is one control that takes you to it, because that is
          * the only place the question can be answered.
          */}
        {deputy ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => { stopRinging(); clearAlarm(); onOpenDeputy?.(); }}
              className="text-[11px] px-2 py-1 rounded-lg"
              style={{
                background: "color-mix(in srgb, var(--primary) 20%, transparent)",
                border: "1px solid color-mix(in srgb, var(--primary) 50%, transparent)",
                color: "var(--text)",
              }}
            >Go to the clone →</button>
            <button
              onClick={() => { stopRinging(); clearAlarm(); }}
              className="text-[11px] px-2 py-1 rounded-lg"
              style={{
                background: "color-mix(in srgb, var(--bg3) 55%, transparent)",
                border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
                color: "var(--text3)",
              }}
            >Later</button>
          </div>
        ) : (
        <div className="flex items-center gap-2">
          <button
            onClick={() => void answer(() => api.reminderAck(alarm.id))}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded-lg"
            style={{
              background: "color-mix(in srgb, var(--success) 20%, transparent)",
              border: "1px solid color-mix(in srgb, var(--success) 50%, transparent)",
              color: "var(--text)",
            }}
          >Done</button>
          <button
            onClick={() => void answer(() => api.reminderSnooze(alarm.id, SNOOZE_MIN))}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded-lg"
            style={{
              background: "color-mix(in srgb, var(--bg3) 55%, transparent)",
              border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
              color: "var(--text3)",
            }}
          >Snooze {SNOOZE_MIN}m</button>
          {onOpenTasks && (
            <button
              onClick={() => { stopRinging(); onOpenTasks(); }}
              className="ml-auto text-[11px] px-2 py-1 rounded-lg"
              style={{ color: "var(--primary)" }}
            >Open the task →</button>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
