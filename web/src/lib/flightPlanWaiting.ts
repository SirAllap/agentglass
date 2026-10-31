/*
 * What waits on a person, for the places that are not the Flight plan view: the
 * top bar's "needs you" chip and the Tasks card chip.
 *
 * One reader for the whole app. It asks nothing while Flight plan is off (one
 * read of the switch at the start, then silence), and while it is on it asks
 * nothing on a timer either: once when the first listener arrives, then when the
 * server says a plan or run changed (`notifyFlightPlanChanged`, called by the
 * live socket) and once when the window comes back into view. The view itself
 * pushes fresher numbers in through `setWaiting` whenever it reads, so the chip
 * and the view never disagree for long.
 */
import { api } from "./api.ts";
import { toPlan } from "./flightPlan.ts";
import { flightGroups, flightItems, needsYou, pilotSnapshot, seatName } from "./flightPilot.ts";

/** An unanswered question from the coordinator, as the chip and the popover name it. */
export interface Ask { id: string; planId: string; title: string; text: string }
/** `plans` is the Go cards (kept for the chip's consumers); `questions`, `go` and `asks` are what needsYou speaks in. */
export interface Waiting { on: boolean; plans: { id: string; title: string }[]; questions: number; go: number; asks: Ask[] }
const NONE: Waiting = { on: false, plans: [], questions: 0, go: 0, asks: [] };
let state: Waiting = NONE;
const subs = new Set<() => void>();

export const getWaiting = (): Waiting => state;
/** The counts may be left out by a caller that only knows the plans: `go` is then the plans, and `questions` and `asks` stay as they were. */
export function setWaiting(next: Pick<Waiting, "on" | "plans"> & Partial<Waiting>): void {
  const n: Waiting = { on: next.on, plans: next.plans, questions: next.questions ?? state.questions, go: next.go ?? next.plans.length, asks: next.asks ?? state.asks };
  const same = <T,>(a: T[], b: T[], eq: (x: T, y: T) => boolean) => a.length === b.length && a.every((x, i) => eq(x, b[i]!));
  if (n.on === state.on && n.questions === state.questions && n.go === state.go && same(n.plans, state.plans, (x, y) => x.id === y.id && x.title === y.title) && same(n.asks, state.asks, (x, y) => x.id === y.id && x.text === y.text)) return;
  state = n;
  for (const fn of subs) fn();
}

export async function refreshWaiting(): Promise<void> {
  try {
    const sw = await api.settingAtGlobal("flightPlan.enabled");
    if (sw.ok && sw.value !== true) { setWaiting(NONE); return; }
    const [p, r] = await Promise.all([api.flightPlans("", "ready"), api.flightRuns()]);
    const byId = new Map((r.runs ?? []).map((x) => [x.id, x]));
    const details = (p.plans ?? []).map(toPlan).map((plan) => ({ plan, run: plan.preflightRunId ? byId.get(plan.preflightRunId) ?? null : null }));
    /* What waits depends on who flies each project: its mode and hold ride on the plans, the spend on the list, and one seat read per project that has a plan. */
    const roots = [...new Set(details.map((d) => d.plan.root))];
    const seats = await Promise.all(roots.map((root) => api.seat(root).catch(() => null)));
    const now = Date.now();
    const plans: Waiting["plans"] = [];
    const asks: Ask[] = [];
    let go = 0;
    roots.forEach((root, i) => {
      const mine = details.filter((d) => d.plan.root === root);
      const first = mine[0]!.plan;
      const snap = pilotSnapshot({ pilot: first.pilot, held: first.held, budget: p.budget, seat: seatName(seats[i]!) });
      const items = flightItems(mine);
      go += needsYou(items, snap).go;
      for (const it of flightGroups(items, now, snap).waiting) {
        const open = (it.questions ?? []).find((q) => q.answer === null);
        if (open) asks.push({ id: open.id, planId: it.plan.id, title: it.plan.title, text: open.text });
        else plans.push({ id: it.plan.id, title: it.plan.title });
      }
    });
    setWaiting({ on: true, plans, go, asks, questions: asks.length });
  } catch { /* the chip is a convenience: stay as it was */ }
}

/** The view listens too: a hold, an answer or a Go from outside re-reads it without a clock. */
const changed = new Set<() => void>();
export function onFlightPlanChanged(fn: () => void): () => void { changed.add(fn); return () => { changed.delete(fn); }; }

let timer: ReturnType<typeof setTimeout> | null = null;
/** The server says a plan or run changed. Bursts (a run writes several states in a row) become one read. */
export function notifyFlightPlanChanged(): void {
  for (const fn of changed) fn();
  if (!subs.size) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void refreshWaiting(); }, 250);
}

const onVisible = (): void => { if (document.visibilityState === "visible") void refreshWaiting(); };

export function subscribeWaiting(fn: () => void): () => void {
  subs.add(fn);
  if (subs.size === 1) {
    void refreshWaiting();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    subs.delete(fn);
    if (subs.size) return;
    if (timer) { clearTimeout(timer); timer = null; }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}
