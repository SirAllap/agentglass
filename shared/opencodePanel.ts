/**
 * Which windows a surface draws for OpenCode Go: the desk's panel and the
 * phone's sheet both call this, so one reading reaches both.
 *
 * Its local windows are the worker steps this machine ran, which under-read the
 * plan (measured 31 Oct: $7.07 here against $15.9 in the console for the same
 * week). So the local numbers are an estimate, and the panel says so on every
 * bar. The console's own reading — from a stored key or a page read — is the
 * plan's number while it is fresh, and stays the number for up to twelve hours
 * after that, until a window in it actually resets. An estimate that reads 21 %
 * where the plan says 54 % is more wrong than a reading a few hours old.
 */
import type { ProviderUsage, QuotaWindow } from "./types.ts";

export const CONSOLE_FRESH_MS = 60 * 60_000;
/** Past this a console reading is a memory whatever its windows say. */
export const CONSOLE_VALID_MS = 12 * 60 * 60_000;

export type PanelWindows = {
  windows: QuotaWindow[];
  estimate: boolean;
  /** Minutes of the windows drawn from this PC because their reset had passed. */
  estimatedMinutes?: number[];
};

const live = (w: QuotaWindow, now: number): boolean =>
  !!w.resetsAt && Date.parse(w.resetsAt) > now;

export function openCodePanelWindows(u: ProviderUsage, now = Date.now()): PanelWindows {
  if (u.provider !== "opencode") return { windows: u.windows, estimate: false };
  const c = u.calibration;
  const fresh = !!c && c.windows.length > 0 && now - c.at <= CONSOLE_FRESH_MS;
  const usable = !!c && c.windows.length > 0 && now - c.at <= CONSOLE_VALID_MS;
  if (usable && (fresh || c.windows.every((w) => live(w, now)))) {
    return { windows: c.windows, estimate: false };
  }
  if (usable) {
    const local = new Map(u.windows.map((w) => [w.minutes, w]));
    const estimatedMinutes: number[] = [];
    const windows = c.windows.map((w) => {
      if (live(w, now)) return w;
      estimatedMinutes.push(w.minutes);
      return local.get(w.minutes) ?? w;
    });
    return { windows, estimate: true, estimatedMinutes };
  }
  return { windows: u.windows, estimate: true };
}

/** Read again before the reading stops being fresh: a stale one still stands, but only until its windows reset. */
export const CONSOLE_REREAD_MS = 4 * 60_000;

/** Whether the console should be read now: a key is stored and the reading is missing or close to stale. */
export function keyReadDue(rows: ProviderUsage[], now = Date.now()): boolean {
  const oc = rows.find((r) => r.provider === "opencode");
  if (!oc?.usageKey) return false;
  const c = oc.calibration;
  return !c || c.windows.length === 0 || now - c.at > CONSOLE_REREAD_MS;
}

/** A stored key and only an estimate in hand: the console has not been read since the server started. */
export function needsKeyRead(rows: ProviderUsage[], now = Date.now()): boolean {
  const oc = rows.find((r) => r.provider === "opencode");
  return !!oc?.usageKey && openCodePanelWindows(oc, now).estimate;
}
