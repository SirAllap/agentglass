// When to warn that a disk is nearly full.
//
// The machine panel shows one quiet badge when free space on any mount is under
// this share of its size: no notification and nothing that repeats, because a
// full disk is a thing to look at once, not a thing to be pinged about.
// Off is 0. The default is 10, the point where a build or a Docker pull starts
// to fail for lack of room on a small root partition.
//
// In localStorage like the window's other preferences: it decides what this
// window draws, and a round trip would put a fetch in front of a badge.
import type { DiskCleanMount } from "../../../shared/types.ts";

const KEY = "agentglass.disk.warnPct";

/** What the Settings row offers; 0 is off. */
export const DISK_WARN_CHOICES: readonly number[] = [0, 5, 10, 15, 20];
export const DISK_WARN_DEFAULT = 10;

export function diskWarnPct(): number {
  try {
    const raw = localStorage.getItem(KEY);
    // A bare Number("") is 0, which would turn the warning off for an empty value.
    if (raw === null || !/^\d+$/.test(raw)) return DISK_WARN_DEFAULT;
    const n = Number(raw);
    return DISK_WARN_CHOICES.includes(n) ? n : DISK_WARN_DEFAULT;
  } catch { return DISK_WARN_DEFAULT; }
}

export function setDiskWarnPct(n: number): void {
  try { localStorage.setItem(KEY, String(n)); } catch { /* private mode: it holds for this window only */ }
}

/** Free space as a share of the disk, 0 to 100; null for a mount that reports no size. */
export const freePct = (m: Pick<DiskCleanMount, "size" | "free">): number | null => (m.size > 0 ? (m.free / m.size) * 100 : null);

/** The mounts with less than `pct` percent free, the ones the badge names. Off is 0, and nothing is under 0 %. */
export function lowDiskMounts<M extends Pick<DiskCleanMount, "size" | "free">>(mounts: readonly M[], pct: number): M[] {
  return mounts.filter((m) => { const f = freePct(m); return f !== null && f < pct; });
}
