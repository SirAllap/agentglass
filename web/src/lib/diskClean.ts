// The decisions behind the machine panel's disk cleanup block, out of the
// component so they can be asserted without a renderer (there is none here).
//
// The block has six faces (idle, scanning, plan, empty, done, error) and one
// rule about what a click may do: it can only ever name lines of the scan on
// screen, and only the ones the scan calls safe and gave something to remove.
// The server checks the same thing again on the press; this is what decides
// which buttons exist at all.
import { useSyncExternalStore } from "react";
import type { DiskCleanLine, DiskCleanLineResult, DiskCleanMount, DiskCleanReport, DiskCleanRunResult, DiskCleanVerdict } from "../../../shared/types.ts";
import { subscribeSettings } from "./settingsRegistry.ts";
import { DISK_WARN_DEFAULT, diskWarnPct, freePct, lowDiskMounts } from "./diskWarnPref.ts";

/** Decimal, like the "N GB free" tile at the top of the same panel and like `df -H`. */
export function fmtBytes(n: number | null): string {
  if (n === null) return "unknown";
  if (n >= 1e12) return `${(n / 1e12).toFixed(n >= 1e13 ? 0 : 1).replace(/\.0$/, "")} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(n / 1e6))} MB`;
}

export type Tone = "ok" | "warn" | "muted" | "bad";
/** The words and colour of a verdict. A colour means one thing here: safe is green, look-first is amber, the rest are quiet. */
export const VERDICT: Record<DiskCleanVerdict, { label: string; tone: Tone; title: string }> = {
  safe: { label: "Safe", tone: "ok", title: "Nothing is using it and it comes back by itself when needed. The plan removes it." },
  ask: { label: "Look first", tone: "warn", title: "Not in the plan. Open it yourself and decide." },
  inuse: { label: "In use", tone: "muted", title: "Something is using it right now, so it stays." },
  explain: { label: "Info", tone: "muted", title: "Shown so the numbers add up. Agentglass never removes it." },
};

const ORDER: Record<DiskCleanVerdict, number> = { safe: 0, ask: 1, inuse: 2, explain: 3 };

/** Safe first (what the person came for), then the biggest; an unmeasured line last in its group. */
export function sortLines(lines: readonly DiskCleanLine[]): DiskCleanLine[] {
  return [...lines].sort((a, b) =>
    ORDER[a.verdict] - ORDER[b.verdict] || (b.bytes ?? -1) - (a.bytes ?? -1) || (a.id < b.id ? -1 : 1));
}

/** The only lines with a button: safe, with something to remove. */
export const cleanable = (l: DiskCleanLine): boolean => l.verdict === "safe" && l.target !== null;

/** The whole plan: every cleanable line, and what it adds up to. */
export function wholePlan(report: DiskCleanReport): { ids: string[]; bytes: number } {
  const lines = report.lines.filter(cleanable);
  return { ids: lines.map((l) => l.id), bytes: lines.reduce((n, l) => n + (l.bytes ?? 0), 0) };
}

export type Phase = "idle" | "scanning" | "error" | "empty" | "plan" | "done";
/** Which face the block shows. A scan in flight wins over everything; a finished clean shows its report until the next scan. */
export function phaseOf(s: { report: DiskCleanReport | null; scanning: boolean; error: string | null; result: DiskCleanRunResult | null }): Phase {
  if (s.scanning) return "scanning";
  if (s.result) return "done";
  if (s.error) return "error";
  if (!s.report) return "idle";
  return wholePlan(s.report).ids.length ? "plan" : "empty";
}

/** What a button that has been pressed once says. Named, so nobody confirms what they did not read. */
export function confirmLabel(n: number, bytes: number): string {
  return `Yes, remove ${n} item${n === 1 ? "" : "s"} (${fmtBytes(bytes)})`;
}

const STATUS: Record<DiskCleanLineResult["status"], { label: string; tone: Tone }> = {
  freed: { label: "Removed", tone: "ok" },
  nothing: { label: "Removed", tone: "muted" },
  planned: { label: "Would remove", tone: "muted" },
  "needs-sudo": { label: "Needs sudo", tone: "warn" },
  refused: { label: "Refused", tone: "bad" },
  failed: { label: "Failed", tone: "bad" },
};

export interface ResultRow { id: string; label: string; chip: string; tone: Tone; note: string; freed: number }
export interface ResultView {
  headline: string;
  rows: ResultRow[];
  mounts: { mount: string; before: number; after: number; gained: number }[];
  /** Lines root owns part of: nothing was escalated, so these are the person's to finish. */
  sudo: string[];
  failed: boolean;
}

/** The report after a clean, in plain words. */
export function resultView(r: DiskCleanRunResult): ResultView {
  const rows = r.lines.map((l): ResultRow => {
    const s = STATUS[l.status];
    const note = l.status === "needs-sudo"
      ? "Root owns part of it. Nothing was escalated; finish it yourself with sudo."
      : l.status === "nothing" ? "Removed, but no space came back on that disk yet." : l.detail ?? "";
    return { id: l.id, label: l.label, chip: s.label, tone: s.tone, note, freed: l.freed };
  });
  const sudo = r.lines.filter((l) => l.status === "needs-sudo").map((l) => l.label);
  const failed = !r.ok;
  return {
    headline: failed ? (r.error ?? "The clean did not run.") : r.dryRun ? "Dry run: nothing was removed." : r.freed > 0 ? `${fmtBytes(r.freed)} freed` : "Nothing came back",
    rows, sudo, failed,
    mounts: r.mounts.map((m) => ({ ...m, gained: Math.max(0, m.after - m.before) })),
  };
}

// ----------------------------------------------------------- the low badge ----

/** The sentence the badge carries, naming what is low; null when nothing is. */
export function lowDiskLabel(mounts: readonly Pick<DiskCleanMount, "mount" | "size" | "free">[], pct: number): string | null {
  const low = lowDiskMounts(mounts, pct);
  const first = low[0];
  if (!first) return null;
  const left = `${Math.round(freePct(first) ?? 0)} % free`;
  return `Low disk: ${first.mount} ${left}${low.length > 1 ? ` (+${low.length - 1} more)` : ""}`;
}

type Mounts = readonly Pick<DiskCleanMount, "mount" | "size" | "free">[];
/* Two sources: the scan names every mount, the machine tile reads only "/" but
   is there before anyone scans. A scan, once made, is the better answer. */
const sources = new Map<"scan" | "tile", Mounts>();
const subs = new Set<() => void>();
const currentMounts = (): Mounts => sources.get("scan") ?? sources.get("tile") ?? [];

export function publishDiskMounts(from: "scan" | "tile", mounts: Mounts | null): void {
  if (mounts === null) sources.delete(from); else sources.set(from, mounts);
  for (const f of subs) f();
}
/** The machine tile's one mount, "/" read from the dials' own numbers; none when the host would not say. */
export function publishMachineDisk(m: { diskTotal: number; diskFree: number }): void {
  publishDiskMounts("tile", m.diskTotal ? [{ mount: "/", size: m.diskTotal, free: m.diskFree }] : null);
}
const subscribeBoth = (fn: () => void): (() => void) => {
  subs.add(fn);
  const off = subscribeSettings(fn);
  return () => { subs.delete(fn); off(); };
};

/** What the badge says right now, from the best mounts known and the setting. */
export const lowDiskNow = (): string | null => lowDiskLabel(currentMounts(), diskWarnPct());
/** The low-disk sentence for the machine panel's tab, or null. Re-read when the setting changes. */
export function useLowDisk(): string | null {
  return useSyncExternalStore(subscribeBoth, lowDiskNow, () => null);
}
/** The setting's value, for the bars that turn amber under it. */
export function useDiskWarnPct(): number {
  return useSyncExternalStore(subscribeSettings, diskWarnPct, () => DISK_WARN_DEFAULT);
}
