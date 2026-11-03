/*
 * The bank: one instrument, one cell per provider.
 *
 * Every number the bar and its sheet print is decided here, so the four states
 * a provider can be in — a reading, an estimate, a spend with no windows, and
 * no reading at all — are testable without a renderer. The one rule the whole
 * file holds: a provider with no reading never gets a number, not even zero.
 */
import type { ProviderUsage, QuotaWindow } from "../../../shared/types.ts";
import { resetLabel } from "./usageStore.ts";

/** "5-hour window", "weekly window", "monthly window", or the model's own name. */
export function windowTitle(w: QuotaWindow): string {
  if (w.minutes === 300) return "5-hour window";
  if (w.minutes === 43200) return "monthly window";
  if (w.minutes === 10080 && w.label === "weekly") return "weekly window";
  if (w.minutes === 10080) return `${w.label} weekly`;
  return `${w.label} window`;
}

/** The noun the sheet's sentence uses: "of the week is used", "of the 5-hour window". */
export function spanPhrase(w: QuotaWindow): string {
  if (w.minutes === 10080 && w.label === "weekly") return "week";
  // A per-model bucket is "the Opus week", not "the Opus weekly" — the adjective
  // form needs a noun, and windowTitle already carries it for the row.
  if (w.minutes === 10080) return `${w.label} week`;
  return windowTitle(w);
}

/** The three-letter tag under a bar percentage. */
export function windowTag(w: QuotaWindow): string {
  if (w.minutes === 300) return "5h";
  if (w.minutes === 10080) return w.label === "weekly" ? "wk" : "models";
  if (w.minutes === 43200) return "mo";
  return w.label;
}

/**
 * The sentence after the number: what the number belongs to, and when the
 * window comes back. The reset is part of it because a percent with no reset is
 * a number nobody can act on.
 *
 * Split in two because the headline draws the number at 22px and the rest as
 * text: one copy of the words, two sizes.
 */
export function sheetTail(w: QuotaWindow, now = Date.now()): string {
  const reset = resetWhen(w, now);
  return ` of the ${spanPhrase(w)} is used${reset ? ` · resets ${reset}` : ""}`;
}

/**
 * When the window comes back, or "" once its reset is behind the clock.
 *
 * The three places that print a reset — the sheet's sentence, the bar's hover
 * and the row under it — ask this one helper: a window that ended while the
 * sheet was open has no "resets now" to promise, and the row used to say it
 * while the headline beside it said nothing.
 */
export function resetWhen(w: QuotaWindow, now = Date.now()): string {
  const ends = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN;
  return Number.isFinite(ends) && ends > now ? resetLabel(w.resetsAt, now) : "";
}

/** The whole sentence, for anything that has no number of its own to draw. */
export function sheetSentence(w: QuotaWindow, now = Date.now()): string {
  return `${w.usedPercent}%${sheetTail(w, now)}`;
}

/**
 * How much of this window has already gone by, in percent.
 *
 * This is the budget a pace line compares against: at 71% of a week used when
 * 58% of the week has passed, the plan is 13 points ahead of where it should
 * be. Null when the provider does not say when the window ends — an unknown
 * budget must draw no marker rather than a marker at zero — and null once the
 * reset is behind us: a window that is over has no budget, and clamping it to
 * 100 would print "80 points under" in green under a reset that already happened.
 */
export function paceBudget(w: QuotaWindow, now = Date.now()): number | null {
  if (!w.resetsAt || !(w.minutes > 0)) return null;
  const ends = Date.parse(w.resetsAt);
  if (!Number.isFinite(ends)) return null;
  if (ends <= now) return null;
  const left = (ends - now) / 60_000;
  const spent = Math.min(w.minutes, Math.max(0, w.minutes - left));
  return Math.round((spent / w.minutes) * 100);
}

export type PaceVerdict = { points: number; tone: "under" | "over" | "level"; text: string };

/** The distance between what is used and what the budget says should be. */
export function paceVerdict(usedPercent: number, budget: number): PaceVerdict {
  const points = Math.round(usedPercent - budget);
  if (points === 0) return { points: 0, tone: "level", text: "level with the budget" };
  const n = Math.abs(points);
  return {
    points: Math.abs(points),
    tone: points > 0 ? "over" : "under",
    text: `${n} ${n === 1 ? "point" : "points"} ${points > 0 ? "over" : "under"}`,
  };
}

const WORD = ["zero", "one", "two", "three", "four", "five", "six", "seven"];

function daysAhead(ms: number): string {
  const d = Math.round(ms / 86_400_000);
  if (d >= 1) return `${WORD[d] ?? d} ${d === 1 ? "day" : "days"}`;
  const h = Math.round(ms / 3_600_000);
  if (h >= 1) return `${h} ${h === 1 ? "hour" : "hours"}`;
  return "less than an hour";
}

function whenLabel(at: number): string {
  const d = new Date(at);
  const day = d.toLocaleDateString([], { weekday: "short" });
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${day} ${time}`;
}

/**
 * "At this pace the week runs out Fri 6:00 AM, two days before it resets."
 *
 * Only when the current rate actually empties the window before it resets:
 * a plan that will reset first has nothing to warn about, and a projection
 * from a window that has barely started is noise. Null is the honest answer.
 */
export function runsOut(w: QuotaWindow, budget: number | null, now = Date.now()): string | null {
  if (!w.resetsAt || budget === null || budget <= 0 || budget >= 100) return null;
  if (w.usedPercent <= 0 || w.usedPercent >= 100) return null;
  const ends = Date.parse(w.resetsAt);
  if (!Number.isFinite(ends)) return null;
  const spentMs = (w.minutes * 60_000 * budget) / 100;
  const emptyAt = now + (spentMs * (100 - w.usedPercent)) / w.usedPercent;
  if (!Number.isFinite(emptyAt) || emptyAt >= ends) return null;
  const noun = spanPhrase(w);
  return `At this pace the ${noun} runs out ${whenLabel(emptyAt)}, ${daysAhead(ends - emptyAt)} before it resets.`;
}

export type BankWindowGroup = { key: string; title: string; windows: QuotaWindow[] };

/**
 * The sheet's rows: the plain windows shortest first, then the per-model weekly
 * buckets as one fold. Windows the provider does not report are simply absent —
 * a zero there would be a fake number.
 */
export function groupWindows(windows: QuotaWindow[]): BankWindowGroup[] {
  const plain: BankWindowGroup[] = [];
  const models: QuotaWindow[] = [];
  for (const w of windows) {
    if (w.minutes === 10080 && w.label !== "weekly") { models.push(w); continue; }
    plain.push({ key: windowTag(w), title: windowTitle(w).replace(/^./, (c) => c.toUpperCase()), windows: [w] });
  }
  plain.sort((a, b) => a.windows[0]!.minutes - b.windows[0]!.minutes);
  if (models.length) plain.push({ key: "models", title: "Per-model weekly", windows: models });
  return plain;
}

/**
 * What the bar's hover says: the full sentence plus the reset.
 *
 * A window with no reading gets the provider's own note and no percent, since
 * "nobody would say" is the answer, not "nothing used".
 */
export function bankTip(u: ProviderUsage, w: QuotaWindow | null, now = Date.now()): string {
  if (!u.available) {
    return `${u.label} — no reading. ${u.note ?? "This provider reports no quota windows."}`;
  }
  if (!w) {
    // A spend total is a reading with no window: dollars, and the span they cover.
    if (u.spend) {
      const source = u.source ? ` from ${u.source}` : "";
      return `${u.label} — $${u.spend.usd.toFixed(2)} spent over ${u.spend.window}${source}. Open details.`;
    }
    return `${u.label} — no reading. ${u.note ?? "This provider reports no quota windows."}`;
  }
  const reset = resetWhen(w, now);
  return `${u.label} — ${windowTitle(w)} ${w.usedPercent}% used${reset ? ` · resets ${reset}` : ""}. Open details.`;
}

export const BANK_CELL_PX = 49;
export const BANK_PLUS_PX = 34;

/**
 * How many cells fit before the tail folds into a "+n".
 *
 * Widths from the mockup: 196px holds four cells, 150px holds two plus the
 * button, 110px holds one plus it. Below one cell plus the button there is no
 * cell to draw: the fold keeps none and the "+n" carries every provider, since
 * a cell drawn in a gap it does not have is clipped by the bar's own overflow.
 */
export function foldCells(availablePx: number, count: number): { shown: number; hidden: number } {
  if (!Number.isFinite(availablePx)) return { shown: count, hidden: 0 };
  if (availablePx >= count * BANK_CELL_PX) return { shown: count, hidden: 0 };
  if (availablePx < BANK_PLUS_PX + BANK_CELL_PX) return { shown: 0, hidden: count };
  const fit = Math.floor((availablePx - BANK_PLUS_PX) / BANK_CELL_PX);
  const shown = Math.max(1, Math.min(count, fit));
  return { shown, hidden: Math.max(0, count - shown) };
}
