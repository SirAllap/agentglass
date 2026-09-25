/**
 * Pace: where a weekly plan window should be by now, and what that means today.
 *
 * ONE module, so the popover, the strip and any future notification cannot
 * answer the same question with different arithmetic. It is pure — no Date.now,
 * no DOM, no storage — and every rule below has a test that pins the number.
 *
 * THE CURVE. A week is not 168 equal hours: nobody spends a weekly quota
 * overnight or on Sunday. The expected fraction used by time t is the share of
 * the window's WORKING time that has passed, W(start, t) / W(start, reset),
 * where working time is the configured hours on the configured days (or every
 * hour, when "every day" is chosen or no day is ticked). It is flat overnight
 * and at weekends, so 09:00 on a working day is a real deadline rather than a
 * point on a diagonal.
 *
 * ELAPSED TIME IS REAL TIME. Segments are built from the wall clock of the
 * configured zone and measured in epoch milliseconds. The window itself is the
 * provider's reset minus its length, always 168 real hours for a week; only the
 * working hours are read on the wall clock, so across a clock change they move
 * by an hour against UTC (measured: 49 working hours in that week, 168 when
 * every hour counts). The reset comes from the provider's timestamp, never
 * from `start + 7 days`.
 *
 * WHAT IT CANNOT DO. It knows the window's used percent and, when the caller
 * has kept samples, how that moved. Without samples the daily cap of the
 * rollover rule cannot be applied (today's spend is unknown) and the burn rate
 * is the week's average per working hour. Both are named in the result rather
 * than guessed. Usage outside working hours counts toward `used` but not toward
 * elapsed working time, so a night owl's average per working hour reads high;
 * the label says "per working hour" and that is all it claims.
 */

export type PaceConfig = {
  /** "working": only the ticked days and hours earn budget. "all": every hour does. */
  spread: "working" | "all";
  /** Monday first: index 0 is Monday, 6 is Sunday. */
  workDays: readonly boolean[];
  /** Hour of the day work starts, 0..23. */
  workStart: number;
  /** Hour of the day work ends, 1..24 (24 = midnight). */
  workEnd: number;
  /** Unused share from earlier today's budget may be spent later (up to one extra day's share). */
  rollover: boolean;
  /** IANA zone the working hours are read in. */
  timeZone: string;
  /** How far back the recent burn rate looks. */
  burnWindowHours: number;
  /** A long window at or past this percent used raises one notification (if the Usage kind is on). */
  alertAt: number;
};

export const DEFAULT_PACE_CONFIG: PaceConfig = {
  spread: "working",
  workDays: [true, true, true, true, true, false, false],
  workStart: 9,
  workEnd: 19,
  rollover: true,
  timeZone: "UTC",
  burnWindowHours: 3,
  alertAt: 90,
};

/** Pace only means something for a window long enough to have days in it. A
 *  five-hour window is spent when it is spent; a working-days curve over it
 *  would be a made-up number wearing a real one's clothes. */
export const PACE_MIN_MINUTES = 1440;

/** One reading of a window's used percent. `gap` marks a reading taken after
 *  the app had not been looking: the jump into it happened at an unknown time,
 *  so a burn rate must not reach back across it. */
export type PaceSample = { t: number; used: number; gap?: boolean };

const MIN = 60_000;
const HOUR = 3_600_000;
/** Two poll intervals and a bit. A reading later than this after the one
 *  before it was taken by an app that had not been looking. */
export const GAP_MS = 12 * MIN;
const EPS = 1e-9;

// ── wall clock ────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoned(ms: number, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour! % 24, mi: p.minute!, s: p.second! };
}

/** Milliseconds the zone is ahead of UTC at this instant. */
function offsetMs(ms: number, timeZone: string): number {
  const p = zoned(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant a zone's wall clock reads `y-mo-d h:00`. Day and hour may
 *  overflow (hour 24, day 32); the calendar rolls them over. */
function localInstant(y: number, mo: number, d: number, h: number, timeZone: string): number {
  // One pace() walks the same ~9 days a dozen times and each call is four
  // formatToParts; a zone's rules do not change under a running page.
  const key = `${timeZone}|${y}|${mo}|${d}|${h}`;
  let hit = instants.get(key);
  if (hit === undefined) {
    const naive = Date.UTC(y, mo - 1, d, h, 0, 0);
    hit = naive - offsetMs(naive - offsetMs(naive, timeZone), timeZone);
    if (instants.size > 2000) instants.clear();
    instants.set(key, hit);
  }
  return hit;
}
const instants = new Map<string, number>();

/** Monday = 0. */
function weekdayIndex(y: number, mo: number, d: number): number {
  return (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
}

// ── working time ──────────────────────────────────────────────────────

type Seg = [number, number];

/** Zero ticked days means "every hour", exactly like choosing it. */
function effective(cfg: PaceConfig): { all: boolean; fellBack: boolean } {
  if (cfg.spread === "all") return { all: true, fellBack: false };
  const none = !cfg.workDays.some(Boolean);
  return { all: none, fellBack: none };
}

/** The working stretches inside [from, to], in order. */
function segments(cfg: PaceConfig, from: number, to: number): Seg[] {
  const out: Seg[] = [];
  if (!(to > from)) return out;
  const { all } = effective(cfg);
  const start = zoned(from, cfg.timeZone);
  const days = Math.ceil((to - from) / (24 * HOUR)) + 2;
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + i));
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate();
    const midnight = localInstant(y, mo, d, 0, cfg.timeZone);
    if (midnight >= to) break;
    let a: number, b: number;
    if (all) {
      a = midnight;
      b = localInstant(y, mo, d + 1, 0, cfg.timeZone);
    } else if (cfg.workDays[weekdayIndex(y, mo, d)]) {
      a = localInstant(y, mo, d, cfg.workStart, cfg.timeZone);
      b = localInstant(y, mo, d, cfg.workEnd, cfg.timeZone);
    } else continue;
    const lo = Math.max(a, from), hi = Math.min(b, to);
    if (hi > lo) out.push([lo, hi]);
  }
  return out;
}

/** W(from, to): working milliseconds in the range. */
export function workingMs(cfg: PaceConfig, from: number, to: number): number {
  let sum = 0;
  for (const [a, b] of segments(cfg, from, to)) sum += b - a;
  return sum;
}

/** The instant at which `need` working milliseconds have passed since `from`,
 *  or null if that is later than `limit`. */
function walk(cfg: PaceConfig, from: number, need: number, limit: number): number | null {
  if (need <= 0) return from;
  let left = need;
  for (const [a, b] of segments(cfg, from, limit)) {
    if (b - a >= left - EPS) return a + left;
    left -= b - a;
  }
  return null;
}

/** The next moment working time begins at or after `from`, within `limit`. */
function nextWorkStart(cfg: PaceConfig, from: number, limit: number): number | null {
  const s = segments(cfg, from, limit)[0];
  return s ? s[0] : null;
}

// ── labels ────────────────────────────────────────────────────────────

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function clock(h: number, mi: number): string {
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** "13:37" · "today 13:37" · "tomorrow 09:00" · "Fri 09:00" · "Wed 30 Sep 15:00".
 *  A bare weekday names the nearest one; the same weekday a week on, or any day
 *  six or more days out, is spelled with its date, because "Wed" from a Wednesday
 *  reads as today. */
export function whenLabel(t: number, now: number, timeZone: string): string {
  const a = zoned(t, timeZone), n = zoned(now, timeZone);
  const dayGap = Math.round((Date.UTC(a.y, a.mo - 1, a.d) - Date.UTC(n.y, n.mo - 1, n.d)) / (24 * HOUR));
  const time = clock(a.h, a.mi);
  if (dayGap === 0) return `today ${time}`;
  if (dayGap === 1) return `tomorrow ${time}`;
  const wd = WEEKDAYS[weekdayIndex(a.y, a.mo, a.d)]!;
  if (dayGap >= 6 || dayGap < 0) return `${wd} ${a.d} ${MONTHS[a.mo - 1]} ${time}`;
  return `${wd} ${time}`;
}

/** Hour of the day as a person says it: 24 is midnight. */
export function hourLabel(h: number): string {
  return h >= 24 ? "midnight" : clock(h, 0);
}

// ── the result ────────────────────────────────────────────────────────

export type PaceInput = {
  /** 0..100 (not clamped: a plan can report more). */
  usedPercent: number;
  /** The window's reset, epoch ms. */
  resetsAt: number;
  windowMinutes: number;
  now: number;
  cfg: PaceConfig;
  /** This window's readings, oldest first. Optional; see the header. */
  samples?: readonly PaceSample[];
};

export type Verdict = "room" | "on-pace" | "cut-back" | "used-up" | "over" | "day-off";
export type PaceStatus = "under" | "on" | "ahead" | "too-early";

export type Burn = {
  source: "recent" | "week" | "none";
  /** % of the window per working hour; 0 when there is nothing to say. */
  perWorkHour: number;
};

export type Projection = {
  kind: "none" | "fits" | "empty-before-reset" | "empty-now";
  atReset: number;
  emptyAt: number | null;
};

export type Pace =
  | { state: "stale"; why: "reset-passed" | "reset-too-far" | "no-working-time" }
  | {
      state: "ok";
      /** Expected % used by now on the working-time curve. */
      expected: number;
      status: PaceStatus;
      /** No day was ticked, so every hour counts. */
      fellBackToEveryHour: boolean;
      today: {
        /** Today has working time left in this window. */
        working: boolean;
        /** Percent of the window that today's working time earns. */
        share: number;
        /** Expected cumulative % at the end of today. */
        endOfDay: number;
        /** % spent today, when it is known. */
        spent: number | null;
        /** Percent still allowed today; negative means over. */
        left: number;
        /** Which term set `left`: the running curve, or the daily cap. */
        binding: "curve" | "cap";
        verdict: Verdict;
        /** When the curve catches up with what is used, if it is behind. */
        backInBudgetAt: number | null;
        /** When the next share starts, when today's is gone or today is off. */
        nextShareAt: number | null;
        /** Today's working hours, for the "ends" caption. */
        endsAtHour: number | null;
      };
      burn: Burn;
      projection: Projection;
    };

function valueAt(samples: readonly PaceSample[], t: number): number | null {
  let v: number | null = null;
  for (const s of samples) {
    if (s.t > t) break;
    v = s.used;
  }
  return v;
}

/** When the reading at `t` was taken, and the first reading after it. */
function around(samples: readonly PaceSample[], t: number): { before: PaceSample | null; next: PaceSample | null } {
  let before: PaceSample | null = null;
  for (const s of samples) {
    if (s.t > t) return { before, next: s };
    before = s;
  }
  return { before, next: null };
}

/** % spent since the start of today's local day, or null if it cannot be known. */
function spentToday(input: PaceInput, start: number, dayStart: number): number | null {
  if (start >= dayStart) return input.usedPercent; // the window began today
  const { before, next } = around(input.samples ?? [], dayStart);
  if (!before) return null;
  // The first reading after midnight came from an app that had not been
  // looking, and the last one before it is old: the jump happened at some
  // unknown time in between, most likely yesterday. Named, not guessed.
  if (next?.gap && dayStart - before.t > GAP_MS) return null;
  return Math.max(0, input.usedPercent - before.used);
}

function burnRate(input: PaceInput, elapsedMs: number): Burn {
  const { cfg, now, usedPercent } = input;
  const samples = input.samples ?? [];
  let lastGap = -Infinity;
  for (const s of samples) if (s.gap && s.t <= now) lastGap = s.t;
  const from = Math.max(now - cfg.burnWindowHours * HOUR, lastGap);
  const before = valueAt(samples, from);
  const w = workingMs(cfg, from, now);
  // Spend is counted over real time and the rate is per WORKING hour, so the
  // lookback must be mostly working time: at 21:00 on a 09-19 day, 3 h back
  // holds no working time at all, and 2 % an hour of evening use divided by
  // the half hour of it that "worked" read as 6 % an hour (measured). Half an
  // hour of working time, and half of the lookback, is the least that says
  // anything about a rate.
  if (before != null && w >= 30 * MIN && w >= 0.5 * (now - from)) {
    return { source: "recent", perWorkHour: Math.max(0, usedPercent - before) / (w / HOUR) };
  }
  if (elapsedMs >= HOUR) return { source: "week", perWorkHour: usedPercent / (elapsedMs / HOUR) };
  return { source: "none", perWorkHour: 0 };
}

/** The hour today's share ends when the window resets before the day does. */
function endsToday(resetsAt: number, dayEnd: number, cfg: PaceConfig): number {
  if (resetsAt >= dayEnd) return 24;
  const r = zoned(resetsAt, cfg.timeZone);
  return r.mi > 0 || r.s > 0 ? r.h + 1 : r.h;
}

export function pace(input: PaceInput): Pace {
  const { cfg, now, resetsAt, usedPercent } = input;
  const windowMs = input.windowMinutes * MIN;
  // A reading whose reset has gone is a reading of the last window; one whose
  // reset is more than a window away belongs to no window we can place. Either
  // would otherwise print a budget for a week that is not this one.
  if (resetsAt <= now) return { state: "stale", why: "reset-passed" };
  if (resetsAt - now > windowMs + MIN) return { state: "stale", why: "reset-too-far" };

  const start = resetsAt - windowMs;
  const tot = workingMs(cfg, start, resetsAt);
  // A 1-6 day window can end before any working time begins (a one-day window
  // resetting on a Sunday): nothing to divide the elapsed share by.
  if (!(tot > 0)) return { state: "stale", why: "no-working-time" };
  const elapsed = workingMs(cfg, start, now);
  const expected = (100 * elapsed) / tot;
  const delta = usedPercent - expected;
  const band = Math.max(1, expected * 0.1);
  const status: PaceStatus = expected < 2 ? "too-early" : delta > band ? "ahead" : delta < -band ? "under" : "on";

  const p = zoned(now, cfg.timeZone);
  const dayStart = localInstant(p.y, p.mo, p.d, 0, cfg.timeZone);
  const dayEnd = localInstant(p.y, p.mo, p.d + 1, 0, cfg.timeZone);
  const shareMs = workingMs(cfg, Math.max(dayStart, start), Math.min(dayEnd, resetsAt));
  const share = (100 * shareMs) / tot;
  const working = shareMs > 0;
  const endOfDay = (100 * workingMs(cfg, start, Math.min(dayEnd, resetsAt))) / tot;
  const spent = spentToday(input, start, dayStart);
  const capTerm = spent == null ? Infinity : (cfg.rollover ? 2 : 1) * share - spent;
  const curveTerm = endOfDay - usedPercent;
  const left = Math.min(curveTerm, capTerm);
  const binding: "curve" | "cap" = capTerm < curveTerm ? "cap" : "curve";

  const nextShareAt = nextWorkStart(cfg, dayEnd, resetsAt);
  let verdict: Verdict;
  if (!working) verdict = "day-off";
  else if (left < -0.05) verdict = "over";
  else if (Math.abs(left) < 0.05) verdict = "used-up";
  else {
    const r = left / share;
    verdict = r > 0.5 ? "room" : r > 0.1 ? "on-pace" : "cut-back";
  }

  // "Back in budget" is only true of the curve: it is when the expected line
  // reaches what is already used. A spent daily cap comes back at the next share.
  let backInBudgetAt: number | null = null;
  if (curveTerm < 0 && (verdict === "over" || verdict === "used-up" || verdict === "cut-back")) {
    backInBudgetAt = walk(cfg, start, (usedPercent / 100) * tot, resetsAt);
  }

  const burn = burnRate(input, elapsed);
  const remainingH = workingMs(cfg, now, resetsAt) / HOUR;
  const atReset = usedPercent + burn.perWorkHour * remainingH;
  let projection: Projection;
  if (usedPercent >= 100) projection = { kind: "empty-now", atReset, emptyAt: null };
  else if (burn.perWorkHour <= 0) projection = { kind: "none", atReset: usedPercent, emptyAt: null };
  else if (atReset <= 100 + EPS) projection = { kind: "fits", atReset, emptyAt: null };
  else {
    const at = walk(cfg, now, ((100 - usedPercent) / burn.perWorkHour) * HOUR, resetsAt);
    projection = { kind: "empty-before-reset", atReset, emptyAt: at };
  }

  return {
    state: "ok", expected, status,
    fellBackToEveryHour: effective(cfg).fellBack,
    today: {
      working, share, endOfDay, spent, left, binding, verdict, backInBudgetAt,
      nextShareAt: verdict === "day-off" || verdict === "used-up" || verdict === "over" ? nextShareAt : null,
      endsAtHour: working && !effective(cfg).all ? Math.min(cfg.workEnd, endsToday(resetsAt, dayEnd, cfg)) : null,
    },
    burn, projection,
  };
}

// ── the alert ─────────────────────────────────────────────────────────

/** The provider's reset timestamp wobbles by seconds between reads, so a
 *  window is the same window when its reset is within ten minutes. */
const SAME_WINDOW_MS = 10 * MIN;

/**
 * Whether a reading should raise the threshold alert. Pure.
 *
 * A reading whose window has already reset, or that belongs to no window we
 * can place, is history: Codex's reading is the last rollout and can be days
 * old, and "93% used, resets Tue" said on Thursday is about a week that is gone.
 * Same test pace() applies before it will print a budget.
 */
export function alertDue(
  usedPercent: number, alertAt: number, resetsAt: number, windowMinutes: number, now: number,
  alertedFor: number | undefined,
): boolean {
  if (usedPercent < alertAt) return false;
  if (resetsAt <= now || resetsAt - now > windowMinutes * MIN + MIN) return false;
  return alertedFor === undefined || Math.abs(resetsAt - alertedFor) >= SAME_WINDOW_MS;
}

// ── words ─────────────────────────────────────────────────────────────

/** Rounded the way it is shown: one decimal below ten, whole above. */
export function pct(n: number): string {
  const v = Math.abs(n) < 10 ? Math.round(n * 10) / 10 : Math.round(n);
  return `${v}%`;
}

/** The one line a person acts on. */
export function verdictText(p: Extract<Pace, { state: "ok" }>, now: number, tz: string): string {
  const t = p.today;
  const next = t.nextShareAt ? whenLabel(t.nextShareAt, now, tz) : null;
  switch (t.verdict) {
    case "day-off":
      return next ? `Day off · next budget ${next}` : "No working hours left in this window";
    case "over":
      return t.binding === "cap"
        ? `Today's share is used up · new share ${next ?? "after the reset"}`
        : `Over today's share by ${pct(-t.left)}${t.backInBudgetAt ? ` · back in budget ${whenLabel(t.backInBudgetAt, now, tz)}` : ""}`;
    case "used-up":
      return `Today's share is used up${next ? ` · new share ${next}` : ""}`;
    case "cut-back":
      return `Cut back · ${pct(t.left)} left today`;
    case "on-pace":
      return `On pace · ${pct(t.left)} left today`;
    case "room":
      return `Room to add work · ${pct(t.left)} left today`;
  }
}

const STATUS_WORDS: Record<PaceStatus, string> = {
  "too-early": "too early to judge", ahead: "ahead of pace", under: "under pace", on: "on pace",
};

/** "budget 17% · under pace" */
export function budgetLine(p: Extract<Pace, { state: "ok" }>): string {
  return `budget ${pct(p.expected)} · ${STATUS_WORDS[p.status]}`;
}

/** The projection sentence, or null when there is nothing honest to say. */
export function projectionText(p: Extract<Pace, { state: "ok" }>, now: number, resetsAt: number, tz: string): string {
  const j = p.projection;
  if (j.kind === "empty-now") return `Empty now · back at the reset ${whenLabel(resetsAt, now, tz)}`;
  if (j.kind === "none") return "No recent use. Nothing to project.";
  if (j.kind === "fits") return `At this speed: ${pct(j.atReset)} at the reset`;
  return j.emptyAt
    ? `At this speed: empty ${whenLabel(j.emptyAt, now, tz)} · before the reset`
    : "At this speed: empty before the reset";
}
