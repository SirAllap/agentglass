import { DEFAULT_PACE_CONFIG, type PaceConfig } from "../../../shared/pace.ts";

/**
 * The working-hours settings the plan pace is measured against.
 *
 * Per machine, like the other display preferences: it describes how this
 * person works, not anything the server needs to know. The zone is not a
 * setting — it is the machine's own, read once, because working hours mean
 * nothing in a zone the person is not in.
 */
const KEY = "agentglass.pace";

function machineZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** Whatever was stored, made into a config that cannot break the arithmetic:
 *  seven day flags, hours in range, and an end after the start. */
export function sanitizePaceConfig(raw: unknown, timeZone: string): PaceConfig {
  const d = DEFAULT_PACE_CONFIG;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const days = Array.isArray(r.workDays) && r.workDays.length === 7
    ? r.workDays.map((x) => x === true) : [...d.workDays];
  const hour = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;
  let workStart = hour(r.workStart, 0, 23, d.workStart);
  let workEnd = hour(r.workEnd, 1, 24, d.workEnd);
  if (workEnd <= workStart) { workStart = d.workStart; workEnd = d.workEnd; }
  return {
    spread: r.spread === "all" ? "all" : "working",
    workDays: days, workStart, workEnd,
    rollover: r.rollover !== false,
    timeZone,
    burnWindowHours: hour(r.burnWindowHours, 1, 12, d.burnWindowHours),
    alertAt: hour(r.alertAt, 50, 100, d.alertAt),
  };
}

let cached: PaceConfig | null = null;
const listeners = new Set<() => void>();

/** The same object until it changes, so a subscriber can compare by reference. */
export function paceConfig(): PaceConfig {
  if (!cached) {
    let raw: unknown = null;
    try { raw = JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { /* private mode or a hand-edited value */ }
    cached = sanitizePaceConfig(raw, machineZone());
  }
  return cached;
}

export function setPaceConfig(patch: Partial<PaceConfig>): void {
  cached = sanitizePaceConfig({ ...paceConfig(), ...patch }, machineZone());
  try { localStorage.setItem(KEY, JSON.stringify(cached)); } catch { /* private mode */ }
  for (const fn of listeners) fn();
}

export function subscribePaceConfig(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
