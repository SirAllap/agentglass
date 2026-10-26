/*
 * THE COORDINATOR, IN THE STATES IT REALLY HAS.
 *
 * The first mockup drew a "paused" state. There is none: a chair is empty,
 * sat in, or stood down (closeSeat), and the seat row outlives each. So the
 * card has exactly these three, decided here from what `/seat` answers, and
 * the card is the same block in all three so nothing moves between them.
 *
 *   none        no row, or a row that only holds settings (never sat in)
 *   on-duty     somebody is in the chair now: a pane that is alive
 *   stood-down  it sat once and is not in the chair now — told to stand down,
 *               or its pane went away
 */
export type CoordState = "none" | "on-duty" | "stood-down";

export interface SeatLike {
  name: string; model: string; powers: "speak" | "nudge" | "assign";
  startedAt: number; endedAt: number | null; adoptedPane: string;
}

export function coordinatorState(seat: SeatLike | null | undefined, live: boolean): CoordState {
  if (!seat) return "none";
  if (live) return "on-duty";
  return seat.startedAt > 0 ? "stood-down" : "none";
}

export const POWER_ORDER = ["speak", "nudge", "assign"] as const;
export type PowerId = (typeof POWER_ORDER)[number];

/** The three powers are cumulative: Unsticks includes Speaks, Assigns includes both. */
export function powersOn(level: PowerId): { id: PowerId; label: string; on: boolean }[] {
  const at = POWER_ORDER.indexOf(level);
  const label = { speak: "Speaks", nudge: "Unsticks", assign: "Assigns" } as const;
  return POWER_ORDER.map((id, i) => ({ id, label: label[id], on: i <= at }));
}

/** What a toggle of one power means as a level: switching Unsticks off drops to Speaks, Assigns on raises to Assigns. */
export function levelAfterToggle(level: PowerId, id: PowerId): PowerId {
  const have = POWER_ORDER.indexOf(level);
  const at = POWER_ORDER.indexOf(id);
  /* Speaks is the floor: a coordinator that reads nothing is not on duty. */
  if (at === 0) return level;
  return have >= at ? POWER_ORDER[at - 1]! : POWER_ORDER[at]!;
}

export type TickKind = "empty" | "woke" | "now";
export interface Tick { kind: TickKind; label: string }

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The last day as five marks and a "now": a mark is blue when the coordinator
 * said something in that fifth of the day (it was woken and spoke), labelled
 * with when. A routine round ("looked, nothing changed") is not a wake: those
 * cost nothing and say nothing, and the screen folds them into one line.
 */
export function wakeTicks(lines: { at: number; line: string }[], now = Date.now(), isRoutine: (l: string) => boolean = () => false, marks = 5): Tick[] {
  const span = DAY / marks;
  const out: Tick[] = Array.from({ length: marks }, () => ({ kind: "empty" as TickKind, label: "" }));
  const latest: number[] = Array.from({ length: marks }, () => 0);
  for (const l of lines) {
    if (isRoutine(l.line)) continue;
    const age = now - l.at;
    if (age < 0 || age >= DAY) continue;
    const i = marks - 1 - Math.floor(age / span);
    /* Two in one window: the later one names it. */
    if (l.at <= latest[i]!) continue;
    latest[i] = l.at;
    const t = new Date(l.at);
    out[i] = { kind: "woke", label: `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}` };
  }
  return [...out, { kind: "now", label: "now" }];
}

/** How far through the floor the coordinator is, and how long is left, in the card's words. */
export function nextLook(wokenAt: number | null, floorHours: number, now = Date.now()): { pct: number; left: string } {
  const span = Math.max(1, floorHours) * HOUR;
  const elapsed = wokenAt ? Math.min(span, Math.max(0, now - wokenAt)) : 0;
  const leftMs = span - elapsed;
  const left = leftMs >= HOUR ? `${Math.max(1, Math.round(leftMs / HOUR))} h` : `${Math.max(1, Math.ceil(leftMs / 60_000))} min`;
  return { pct: Math.round((elapsed / span) * 100), left };
}
