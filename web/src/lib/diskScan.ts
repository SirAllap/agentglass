// A disk scan runs on the server and goes on when the Machine panel closes. This is
// what every view of it (the header pill, the panel, the toast) reads, fed by the
// server's own frame when a scan starts, moves or ends. No clock.
import { useSyncExternalStore } from "react";
import type { DiskCleanReport } from "../../../shared/types.ts";
import { reclaimHeadline, wholePlan } from "./diskClean.ts";

export interface DiskScanState { scanning: boolean; reading: string | null }
export interface KeptRead { report: DiskCleanReport | null; scanning?: boolean; reading?: string | null }

let now: DiskScanState = { scanning: false, reading: null };
const subs = new Set<() => void>();
export const diskScanNow = (): DiskScanState => now;
export const resetDiskScan = (): void => { now = { scanning: false, reading: null }; };
export const subscribeDiskScan = (fn: () => void): (() => void) => { subs.add(fn); return () => { subs.delete(fn); }; };
export const useDiskScan = (): DiskScanState => useSyncExternalStore(subscribeDiskScan, diskScanNow, () => now);

/** The header pill's words while a scan runs, or null when none does. */
export const scanPillLabel = (s: DiskScanState): string | null => (s.scanning ? `Disk cleanup · Scanning…${s.reading ? ` ${s.reading}` : ""}` : null);

/** The toast's words, from the scan that just ended. */
export function scanFinishedText(report: DiskCleanReport): string {
  return `Disk scan finished · ${reclaimHeadline(wholePlan(report)) ?? "nothing to remove"}`;
}

/** Take what the server says about its scan. Returns the toast text exactly once, on the edge from running to finished; never on a first read. */
export function applyKept(k: KeptRead): string | null {
  const was = now.scanning;
  const next: DiskScanState = { scanning: k.scanning === true, reading: k.scanning === true ? k.reading ?? null : null };
  if (next.scanning !== was || next.reading !== now.reading) { now = next; for (const f of subs) f(); }
  return was && !next.scanning && k.report ? scanFinishedText(k.report) : null;
}

/**
 * Replies to "what does the kept scan say" come back in any order: at a scan's end the frames arrive back to back, and an
 * older reply (still scanning) landing last would leave the pill on "Scanning…" and lose the finished toast. `ticket()`
 * numbers each ask; a reply is `fresh` only while no later ask was made.
 */
export function latestOnly(): () => () => boolean {
  let last = 0;
  return () => { const mine = ++last; return () => mine === last; };
}

/** The scans (by stamp) whose report already started by itself once: a cancel or a failure is the person's to retry, never redone on the next open. */
const autoStarted = new Set<number>();
export function claimAutoReport(scanAt: number): boolean {
  if (autoStarted.has(scanAt)) return false;
  autoStarted.add(scanAt);
  return true;
}
export const resetAutoReports = (): void => autoStarted.clear();
