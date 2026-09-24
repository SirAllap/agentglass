/*
 * THE LANTERN'S OWN CLOCK, and the reason its icon can light from anywhere.
 *
 * One reader of /agents/board for the whole app, not one per surface: the rail
 * wants a count (is anybody stopped on me?) and the view wants the rows, and
 * two pollers for one fact is how the rail says 1 while the view says 0.
 *
 * Paced by who is looking. Twenty seconds while nothing but the rail cares —
 * the read is ~10ms on the server, but a poll that nobody will act on for a
 * minute does not need to run four times in it — and five while the view is
 * open, which is the moment "right now" is the whole question. And at once,
 * the moment either subscribes: the old view waited out its first interval
 * before it read anything, which showed "reading…" for five seconds on a
 * screen that opens to find out what is happening now.
 *
 * A `useSyncExternalStore` store like the chat and reminder counts beside it
 * in Workspace, so the rail's pip is derived and never set by hand.
 */
import { api } from "./api.ts";
import type { LanternRow, LanternWatch } from "../components/LanternView.tsx";
import { attention } from "../../../shared/fieldRules.ts";

let rows: LanternRow[] | null = null;
let watch: LanternWatch | null = null;
let cacheTtlMin = 5;
let readAt = 0;
let error = false;
/** Whether any read has ever succeeded: a failure after one is a stale
 *  answer, a failure before one is no answer at all. */
let known = false;
const listeners = new Set<() => void>();
/** How many subscribers want the fast clock — the view, when it is on screen. */
let watching = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

const SLOW_MS = 20_000;
const FAST_MS = 5_000;

function emit() { for (const l of listeners) l(); }

const looking = () => typeof document === "undefined" || (!document.hidden && document.hasFocus());

export async function refreshLantern(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const r = await api.agentBoard();
      rows = r.ok ? (r.agents ?? []) : (rows ?? []);
      if (r.ok && r.watch) watch = r.watch;
      if (r.ok && typeof r.cacheTtlMinutes === "number") cacheTtlMin = r.cacheTtlMinutes;
      error = !r.ok;
      if (r.ok) known = true;
    } catch {
      // Keep the last answer on screen: a server that is restarting is not the
      // same as nobody being around, and blanking the list would say it was.
      error = true;
      if (rows === null) rows = [];
    } finally {
      readAt = Date.now();
      inFlight = null;
      emit();
      schedule();
    }
  })();
  return inFlight;
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!listeners.size) return;
  timer = setTimeout(() => { if (looking()) void refreshLantern(); else schedule(); }, watching > 0 ? FAST_MS : SLOW_MS);
}

function onLooking() { if (listeners.size && looking()) void refreshLantern(); }

/** Subscribe to the rows and the count. `fast` while a surface that shows the
 *  rows is on screen. */
export function subscribeLantern(l: () => void, fast = false): () => void {
  listeners.add(l);
  if (fast) watching++;
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("focus", onLooking);
    document.addEventListener("visibilitychange", onLooking);
  }
  // At once, not after the first interval — and again if the last answer is
  // older than the fast clock, so a view that reopens is current on arrival.
  if (rows === null || Date.now() - readAt > FAST_MS) void refreshLantern();
  else schedule();
  return () => {
    listeners.delete(l);
    if (fast) watching = Math.max(0, watching - 1);
    if (!listeners.size) {
      if (timer) clearTimeout(timer);
      timer = null;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onLooking);
        document.removeEventListener("visibilitychange", onLooking);
      }
    } else schedule();
  };
}

export const lanternRows = (): LanternRow[] | null => rows;
export const lanternFailed = (): boolean => error;
export const lanternKnown = (): boolean => known;
/** What the watch last found, from the same answer. */
export const lanternWatch = (): LanternWatch | null => watch;
/** The provider's prompt-cache window, from Settings — what the cards count down. */
export const lanternCacheTtlMs = (): number => cacheTtlMin * 60_000;
/** How many agents CANNOT go on without a person right now — a permission
 *  or a held gate — the rail's number. A turn that merely ended is waiting,
 *  not blocked, and is not a number that follows you around the app. Sorted
 *  by `attention`, the rule the dashboard's strip counts "needs you" by, so
 *  the pip and the strip are one number. */
export const lanternNeed = (): number => rows?.filter((r) => attention(r) === "blocked").length ?? 0;

/**
 * The field in the view's order, and what each row is set aside as.
 *
 * A row the server marked GONE — no pane on this machine and quiet for hours
 * (`isGone` in lantern.ts, the same rule the readout collapses on) — is not
 * an idle agent. The view drew every one of them as one: on the owner's
 * board, twenty-five cards with five agents alive behind them, the rest names
 * whose sessions had ended one and two days before without saying `done`.
 * Set aside here so the fold under Idle holds agents, and the fold under Gone
 * holds names a person can clear.
 */
export function groupLantern(rows: LanternRow[]): { need: LanternRow[]; finished: LanternRow[]; working: LanternRow[]; idle: LanternRow[]; gone: LanternRow[] } {
  /* Two kinds of "needs you", and only one of them is urgent. A permission
     or a held gate is an agent that CANNOT go on without you. A turn that
     ended is an agent that finished and is waiting for whatever you say next
     — its own group, not a number on the rail. Either outranks everything
     below, gone included: a wait is never collapsed. "Blocked" is
     `attention`'s, the rule the dashboard's strip and the rail's pip count
     by, so the three are one number. */
  const need = rows.filter((r) => attention(r) === "blocked");
  const finished = rows.filter((r) => r.needsYou?.kind === "input");
  const gone = rows.filter((r) => !r.needsYou && r.gone);
  const working = rows.filter((r) => !r.needsYou && !r.gone && r.state === "working");
  const idle = rows.filter((r) => !r.needsYou && !r.gone && r.state === "idle");
  return { need, finished, working, idle, gone };
}

/** For tests that render the view with a known board — or, with null, put the
 *  store back to never having read one. */
export function __setLanternRows(next: LanternRow[] | null): void {
  rows = next; known = next !== null; error = false; readAt = Date.now(); emit();
}
