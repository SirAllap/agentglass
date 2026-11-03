/*
 * "Take me to the Flight plan."
 *
 * The view has no rail icon, so it is reached from the thing it belongs to: the
 * top bar's chip, a task card, the Agents screen, the palette, a Settings link.
 * Each of them asks here, the same one-slot mailbox as openSettings and
 * viewModalIntent: the sender does not know whether the view is mounted, App
 * installs the one function that can show it, and the view drains the request
 * when it mounts or when a new one arrives. Both orders work.
 */
export type FlightPlanTab = "plans" | "history" | "settings";
export interface FlightPlanIntent {
  tab?: FlightPlanTab;
  /** Open this plan. */
  plan?: string;
  /** Open the card that asks the person about this plan (its question, or Go), over the Flying list. */
  card?: string;
  /** Open the composer, optionally filled in from a task. */
  compose?: { root?: string; request?: string; taskId?: string; from?: string };
}

/** Long enough for the view to mount; short enough that a request nobody was there for does not fire at the next visit. */
export const INTENT_TTL_MS = 30_000;

let pending: { intent: FlightPlanIntent; at: number } | null = null;
let show: (() => void) | null = null;
const subs = new Set<() => void>();

/** App installs this: the function that brings the view forward. */
export function onShowFlightPlan(fn: (() => void) | null): () => void {
  show = fn;
  return () => { if (show === fn) show = null; };
}

export function openFlightPlan(intent: FlightPlanIntent = {}): void {
  pending = { intent, at: Date.now() };
  show?.();
  for (const fn of subs) { try { fn(); } catch { /* one bad listener must not stop the rest */ } }
}

/** Read and clear the fresh request, if there is one. */
export function takeFlightPlanIntent(now: number = Date.now()): FlightPlanIntent | null {
  if (!pending || now - pending.at > INTENT_TTL_MS) { pending = null; return null; }
  const i = pending.intent;
  pending = null;
  return i;
}

export function subscribeFlightPlanIntent(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
