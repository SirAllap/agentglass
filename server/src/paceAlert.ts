import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { alertDue, PACE_MIN_MINUTES } from "../../shared/pace.ts";
import { notifies } from "../../shared/notifyPrefs.ts";
import type { PaceAlert, ProviderUsage } from "../../shared/types.ts";
import { readNotifyPrefs } from "./notifyPrefs.ts";

/**
 * The threshold alert for a long plan window, decided in ONE place.
 *
 * It used to be decided in each renderer, with the "already told" mark in that
 * renderer's localStorage. The desktop shell and every browser tab are
 * different origins, so each kept its own mark and each raised its own row and
 * popup for the same window (two Electron windows on one origin raced too). The
 * server is the one thing all of them share: it keeps the mark, on disk, so a
 * restart does not tell the person again, and a claim is a synchronous
 * read-decide-write that two callers cannot interleave.
 *
 * Off while the Usage kind is off, and nothing is remembered then: a window
 * already past the level when the person turns Usage on still reports once.
 *
 * Ceiling: one level for every long window, and it is sent by whichever
 * client claims first. Delivery is to the clients connected at that moment.
 */

function stateDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass");
}
export function paceAlertedPath(): string {
  return join(stateDir(), "pace-alerted.json");
}

/** Only the scratch directory is readable or writable under test, as in notifyPrefs.ts. */
function offLimits(p: string): boolean {
  const scratch = tmpdir();
  return process.env.NODE_ENV === "test" && p !== scratch && !p.startsWith(scratch + "/");
}

let cache: Record<string, number> | null = null;

function read(): Record<string, number> {
  if (cache) return cache;
  const p = paceAlertedPath();
  cache = {};
  if (offLimits(p) || !existsSync(p)) return cache;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) cache[k] = v;
    }
  } catch { /* a corrupt file means one repeated alert, not a dead server */ }
  return cache;
}

function write(seen: Record<string, number>): void {
  const p = paceAlertedPath();
  if (offLimits(p)) return;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(seen) + "\n", { mode: 0o600 });
  } catch { /* best effort: the mark still holds in memory for this run */ }
}

/** Test seam: forget the in-memory copy so the file is read again. */
export function __resetPaceAlerted(): void { cache = null; }

/** A person's level, or the default for anything that is not 50..100. */
export function coerceAlertAt(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 50 && v <= 100 ? v : 90;
}

/** The windows that have newly reached `alertAt`, each marked as told. */
export function claimPaceAlerts(rows: ProviderUsage[], alertAt: number, now = Date.now()): PaceAlert[] {
  const prefs = readNotifyPrefs();
  if (!notifies(prefs, "usage", "bell") && !notifies(prefs, "usage", "desktop")) return [];
  const seen = read();
  const out: PaceAlert[] = [];
  for (const u of rows) {
    if (!u.available) continue;
    for (const w of u.windows) {
      if (w.minutes < PACE_MIN_MINUTES || !w.resetsAt) continue;
      const resetsAt = new Date(w.resetsAt).getTime();
      if (!Number.isFinite(resetsAt)) continue;
      const k = `${u.provider}|${w.label}`;
      if (!alertDue(w.usedPercent, alertAt, resetsAt, w.minutes, now, seen[k])) continue;
      seen[k] = resetsAt;
      out.push({ provider: u.provider, providerLabel: u.label, label: w.label, usedPercent: w.usedPercent, minutes: w.minutes, resetsAt, alertAt });
    }
  }
  if (out.length) write(seen);
  return out;
}
