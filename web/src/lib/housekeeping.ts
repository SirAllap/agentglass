/*
 * The Lantern's Housekeeping rows: what the automatic cleanup after a merge is
 * doing and has done (server/src/cleanupAuto.ts, GET /cleanup/auto).
 *
 * The pure part that turns entries into the rows the section draws (the store
 * that holds them is housekeepingStore.ts). One row per pull request, changed in place:
 * "Cleaning ORBIT-1042..." becomes "ORBIT-1042 cleaned, 6.2 GB freed" without
 * moving. A blocked pull request or one with nothing to clean has no row here;
 * its reason is for the PR's badge. Nothing here is "needs you".
 */
import { humanSize as fmtBytes } from "../../../shared/dockerSize.ts";
import type { CleanupNote } from "./cleanupPr.ts";

export interface AutoItem { kind: string; target: string; status: "done" | "failed" | "warn" | "skipped"; detail: string; bytes?: number }
export interface AutoEntry {
  repo: string; pr: number; state: "cleaning" | "cleaned" | "blocked" | "failed" | "nothing";
  label: string; slug: string; title: string; reason: string; done: number; total: number; freed: number;
  /** 1 when the only thing holding the run is a tab or session in the checkout: it clears on its own. */
  waiting?: number;
  started_at: number; ended_at: number | null; items: AutoItem[];
}

export interface HkRow {
  key: string;
  tone: "run" | "ok" | "warn";
  title: string;
  sub: string;
  /** Right side, on a running row: the bytes so far. */
  badge?: string;
  /** Still running or finished in the last ten minutes: drawn with the soft ground and the colour. */
  fresh: boolean;
  /** What "Details" opens: one line per item. */
  lines: string[];
}

const DAY = 86_400_000;
const FRESH_MS = 600_000;
export function whenWord(at: number, now: number): string {
  const s = Math.max(0, now - at);
  if (s < 60_000) return "just now";
  if (s < 3_600_000) return `${Math.floor(s / 60_000)} min ago`;
  if (s < DAY) return `${Math.floor(s / 3_600_000)} h ago`;
  if (s < 2 * DAY) return "yesterday";
  return `${Math.floor(s / DAY)} days ago`;
}

const nameOf = (e: AutoEntry): string => e.slug || `#${e.pr}`;
const itemLine = (i: AutoItem): string =>
  `${i.status === "done" ? "Removed" : i.status === "failed" ? "Failed" : i.status === "warn" ? "Done with a warning" : "Left alone"}: ${i.target}${i.status === "done" && i.bytes ? ` (${fmtBytes(i.bytes)})` : ""}${i.status === "failed" || i.status === "warn" ? ` - ${i.detail}` : ""}`;

/** The newest entry of one pull request; undefined when the automatic cleanup has said nothing about it. */
export const autoEntryFor = (entries: readonly AutoEntry[], repo: string, pr: number): AutoEntry | undefined =>
  entries.filter((e) => e.repo === repo && e.pr === pr).sort((a, b) => b.started_at - a.started_at)[0];

/** Running first, then the newest finished ones. Blocked and nothing-to-clean entries are not rows. */
export function housekeepingRows(entries: readonly AutoEntry[], now: number): HkRow[] {
  const shown = entries.filter((e) => e.state === "cleaning" || e.state === "cleaned" || e.state === "failed");
  const rank = (e: AutoEntry) => (e.state === "cleaning" ? 0 : 1);
  return [...shown].sort((a, b) => rank(a) - rank(b) || b.started_at - a.started_at).map((e): HkRow => {
    const key = `${e.repo}#${e.pr}`;
    if (e.state === "cleaning") {
      return { key, tone: "run", title: `Cleaning ${nameOf(e)}...`, sub: `${e.label} · ${e.done} of ${e.total} removed`, badge: e.freed > 0 ? `${fmtBytes(e.freed)} so far` : undefined, fresh: true, lines: [] };
    }
    const at = e.ended_at ?? e.started_at;
    if (e.state === "failed") {
      return { key, tone: "warn", title: `${nameOf(e)} not fully cleaned`, sub: `${e.label} · ${whenWord(at, now)}${e.reason ? ` · ${e.reason}` : ""}`, fresh: now - at < FRESH_MS, lines: e.items.map(itemLine) };
    }
    return { key, tone: "ok", title: `${nameOf(e)} cleaned${e.freed > 0 ? `, ${fmtBytes(e.freed)} freed` : ""}`, sub: `${e.label} · ${whenWord(at, now)}`, fresh: now - at < FRESH_MS, lines: e.items.map(itemLine) };
  });
}

/**
 * The runs that went from "cleaning" to "cleaned" between two reads of the
 * entries: what the one cleanup toast announces, newest first. The first read
 * of a boot has nothing before it, so it announces nothing.
 */
export function autoJustCleaned(before: readonly AutoEntry[], after: readonly AutoEntry[]): AutoEntry[] {
  const was = new Map(before.map((e) => [keyOf(e), e.state]));
  return after.filter((e) => e.state === "cleaned" && was.get(keyOf(e)) === "cleaning").sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0));
}

const keyOf = (e: AutoEntry): string => `${e.repo}#${e.pr}`;

/** Whether a finished run left something a person can put back: a brief it moved to archive/. */
export const undoableRun = (e: AutoEntry): boolean =>
  e.state === "cleaned" && e.items.some((i) => i.kind === "brief" && i.status === "done");

/** A finished automatic run, as the cleanup toast says it: the same note a run from the dialog leaves. */
export function autoNote(e: AutoEntry): CleanupNote {
  const freed = e.freed > 0 ? ` \u00b7 ${fmtBytes(e.freed)} freed` : "";
  return {
    key: keyOf(e),
    text: `Cleaned ${nameOf(e)}${freed}`,
    tone: e.items.some((i) => i.status === "failed") ? "warn" : "ok",
    lines: e.items.filter((i) => i.kind !== "own-state" && i.kind !== "worklog").map(itemLine),
  };
}
