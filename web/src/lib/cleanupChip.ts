/*
 * The window bar's sign that Automatic cleanup is working: what the chip says,
 * from the Housekeeping entries and the count of pull requests still waiting.
 * Pure, so the rule "nothing when idle" is asserted here and not by looking.
 */
import { humanSize as fmtBytes } from "../../../shared/dockerSize.ts";
import type { AutoEntry } from "./housekeeping.ts";

export interface CleanupChip {
  /** "Cleaning 3 of 10", or "Cleaning" while the next one is still being read. */
  label: string;
  /** The queue behind the current pull request, "+2" or "". */
  more: string;
  /** 0..1 for the thin bar; null when no pull request is running yet. */
  fraction: number | null;
  /** The tooltip: which pull request, items done, bytes freed so far. */
  tip: { name: string; text: string };
}

/** One pull request is cleaned at a time; the newest running entry is the current one. */
export function cleanupChip(entries: readonly AutoEntry[], queued: number): CleanupChip | null {
  const cur = entries.filter((e) => e.state === "cleaning").sort((a, b) => b.started_at - a.started_at)[0];
  const waiting = Math.max(0, Math.floor(queued) || 0);
  if (!cur && waiting === 0) return null;
  const more = waiting > 0 ? `+${waiting}` : "";
  const behind = waiting > 0 ? ` ${waiting} more waiting.` : "";
  if (!cur) return { label: "Cleaning", more, fraction: null, tip: { name: "Automatic cleanup", text: `Starting the next merged pull request.${behind}` } };
  const name = cur.slug || `#${cur.pr}`;
  const freed = cur.freed > 0 ? `, ${fmtBytes(cur.freed)} freed so far` : "";
  return {
    label: `Cleaning ${cur.done} of ${cur.total}`,
    more,
    fraction: cur.total > 0 ? Math.min(1, cur.done / cur.total) : 0,
    tip: { name: `Cleaning ${name}`, text: `${cur.done} of ${cur.total} items removed${freed}.${behind}` },
  };
}
