import type { PrSummary } from "../../../shared/types.ts";

/** When it ended: the facts of a finished pull request arrive in a second pass, until then the list's own stamp. */
export const closedAt = (p: PrSummary): string => p.closed?.at ?? p.updatedAt;

/** Today, Yesterday, This week, Last week, then the month: by the local calendar day it ended. */
export function dayGroup(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "Earlier";
  const day = (d: Date) => Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
  const age = day(now) - day(t);
  if (age <= 0) return "Today";
  if (age === 1) return "Yesterday";
  const weekStart = day(now) - ((now.getDay() + 6) % 7);
  if (day(t) >= weekStart) return "This week";
  if (day(t) >= weekStart - 7) return "Last week";
  return t.toLocaleString("en-GB", { month: "long", year: "numeric" });
}

/** Rows (already newest first) cut into their groups, in order. */
export function groupClosed<T extends { at: string }>(rows: T[], now: Date = new Date()): { label: string; rows: T[] }[] {
  const out: { label: string; rows: T[] }[] = [];
  for (const r of rows) {
    const label = dayGroup(r.at, now);
    const last = out[out.length - 1];
    if (last && last.label === label) last.rows.push(r); else out.push({ label, rows: [r] });
  }
  return out;
}
