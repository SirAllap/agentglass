/*
 * What is currently shouting at you, held in one place.
 *
 * Three surfaces need this and they are not all on screen at once: the band at
 * the top of the task list, the rail pip, and the "needs you" collector. If
 * each polled for itself, the rail would be counting something the panel had
 * already dismissed — so there is one poller and they all read its answer.
 *
 * The poll runs whether or not the task view is open, because that is the
 * point: a reminder that only arrives when you are already looking at the
 * reminder list is not a reminder. It is cheap — one indexed read of tens of
 * rows — and it stops when the tab is hidden, like everything else here.
 */
import { api } from "./api.ts";
import type { Reminder } from "../../../shared/types.ts";

let live: Reminder[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();

const emit = () => { for (const f of subs) f(); };

async function refresh(): Promise<void> {
  try {
    const r = await api.reminders("live");
    // Reference equality is what useSyncExternalStore compares, so a poll that
    // found nothing new must not hand back a new array — or every subscriber
    // re-renders every few seconds for no reason.
    const same = r.reminders.length === live.length
      && r.reminders.every((x, i) => x.id === live[i]!.id && x.firedAt === live[i]!.firedAt);
    if (!same) { live = r.reminders; emit(); }
  } catch { /* the next tick tries again */ }
}

function ensurePolling(): void {
  if (timer) return;
  void refresh();
  timer = setInterval(() => { if (!document.hidden) void refresh(); }, 20_000);
}

export function subscribeReminders(fn: () => void): () => void {
  subs.add(fn);
  ensurePolling();
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) { clearInterval(timer); timer = null; }
  };
}

export const liveReminders = (): Reminder[] => live;
export const firedCount = (): number => live.length;

/** After anything that changes a reminder, so the surfaces do not wait out the
 *  poll to agree with the click that just happened. */
export const nudgeReminders = (): Promise<void> => refresh();
