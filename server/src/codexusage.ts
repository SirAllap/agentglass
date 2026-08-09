// Codex plan quota, read off disk.
//
// The CLI records the rate-limit snapshot it got from the API into its session
// rollout files (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), inside the
// `token_count` events. That makes this the cheapest usage source in the app:
// no credentials, no network, no endpoint that can rate-limit us for asking.
//
// It buys that with staleness. `rate_limits` is only written when a turn runs,
// so this reading is as old as your last Codex conversation — which is why
// `observedAt` is not optional decoration here, and why the refresh ping in
// index.ts exists at all. A number with no age on it would be a lie by omission
// the first time somebody read it after a quiet weekend.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProviderUsage, QuotaWindow } from "../../shared/types.ts";
import { windowLabel } from "../../shared/quota.ts";
import { codexHome, CODEX_ENABLED, codexModels } from "./codex.ts";
import { singleFlight } from "./singleflight.ts";

/**
 * How many rollout files to open before giving up.
 *
 * More than one because the newest file may be a session that has not taken a
 * turn yet and so has no `token_count` in it. Bounded because a rollout is
 * read whole, and "scan until you find one" over a year of sessions is an
 * unbounded read on the thread that also carries the terminal.
 */
const MAX_FILES = 5;

const LABEL = "Codex";

function unavailable(note: string): ProviderUsage {
  return { provider: "codex", label: LABEL, available: false, windows: [], note };
}

/** Numeric directory entries, newest name first. The layout is YYYY/MM/DD, so
 *  lexical order on a zero-padded name is chronological order. */
function descendingDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));
  } catch { return []; }
}

/** The most recent rollout files, newest first, capped at MAX_FILES. */
function recentRollouts(root: string): string[] {
  const out: { path: string; mtime: number }[] = [];
  for (const y of descendingDirs(root)) {
    for (const m of descendingDirs(join(root, y))) {
      for (const d of descendingDirs(join(root, y, m))) {
        const dayDir = join(root, y, m, d);
        let names: string[] = [];
        try { names = readdirSync(dayDir).filter((n) => n.endsWith(".jsonl")); } catch { continue; }
        for (const n of names) {
          const p = join(dayDir, n);
          try { out.push({ path: p, mtime: statSync(p).mtimeMs }); } catch { /* vanished */ }
        }
        // A whole day gathered at a time, so files written out of order within
        // one day still sort correctly against each other.
        if (out.length >= MAX_FILES) {
          return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES).map((f) => f.path);
        }
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES).map((f) => f.path);
}

type RawWindow = { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };

function quotaWindow(w: unknown): QuotaWindow | null {
  const r = w as RawWindow | null;
  if (!r || typeof r.used_percent !== "number" || typeof r.window_minutes !== "number") return null;
  return {
    label: windowLabel(r.window_minutes),
    minutes: r.window_minutes,
    usedPercent: Math.round(r.used_percent),
    // Unix SECONDS in the file. Multiplying is not optional: as milliseconds
    // this lands in 1970 and every reset renders as "now".
    resetsAt: typeof r.resets_at === "number" ? new Date(r.resets_at * 1000).toISOString() : null,
  };
}

/** The last `rate_limits` in one file, or null. Scanned backwards: the newest
 *  reading is at the end, and a rollout is mostly lines this does not want. */
function lastRateLimits(path: string): { windows: QuotaWindow[]; plan?: string } | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line || !line.includes("rate_limits")) continue;
    let doc: unknown;
    try { doc = JSON.parse(line); } catch { continue; } // a truncated final write
    const rl = (doc as any)?.payload?.rate_limits;
    if (!rl) continue;
    const windows = [quotaWindow(rl.primary), quotaWindow(rl.secondary)].filter((w): w is QuotaWindow => !!w);
    if (!windows.length) continue;
    // Shortest window first, so a 5h meter never renders below the weekly one
    // it is nested inside. Ordered on length rather than on the primary/
    // secondary keys, which are positional and swap between plans.
    windows.sort((a, b) => a.minutes - b.minutes);
    return { windows, plan: typeof rl.plan_type === "string" ? rl.plan_type : undefined };
  }
  return null;
}

/** Keyed on the file we read and its mtime: repeat calls are free until Codex
 *  writes again, and a new turn invalidates without a timer. */
let cache: { key: string; value: ProviderUsage } | null = null;

export function codexUsage(): ProviderUsage {
  const root = join(codexHome(), "sessions");
  if (!existsSync(root)) {
    return unavailable("No Codex sessions on this machine yet — run a Codex turn and the quota appears here.");
  }
  const files = recentRollouts(root);
  if (!files.length) {
    return unavailable("No Codex sessions on this machine yet — run a Codex turn and the quota appears here.");
  }
  let mtime = 0;
  try { mtime = statSync(files[0]!).mtimeMs; } catch { /* fine */ }
  const key = `${files[0]}:${mtime}`;
  if (cache && cache.key === key) return cache.value;

  let value: ProviderUsage = unavailable(
    "No recent Codex turn recorded its quota — run a Codex turn to refresh it.",
  );
  for (const path of files) {
    const hit = lastRateLimits(path);
    if (!hit) continue;
    let observedAt = Date.now();
    try { observedAt = statSync(path).mtimeMs; } catch { /* fine */ }
    value = {
      provider: "codex", label: LABEL, available: true,
      windows: hit.windows, plan: hit.plan, observedAt,
    };
    break;
  }
  cache = { key, value };
  return value;
}

/** Test seam: forget the cached reading. */
export function __resetCodexUsageCache(): void { cache = null; }

/**
 * Which model the refresh ping runs on.
 *
 * Codex does not label a model "cheapest", so this does not guess. The list
 * `parseModels()` produces is sorted by Codex's own `priority`, largest first,
 * so its last entry is the smallest thing on offer. An explicit override wins,
 * and an empty list means no `--model` flag at all rather than an invented id —
 * a hardcoded model that is not on the user's plan is a feature that fails for
 * everyone except the person who wrote it.
 */
export function usageRefreshModel(models: { id: string }[]): string | null {
  const override = process.env.AGENTGLASS_CODEX_USAGE_MODEL;
  if (override) return override;
  return models.length ? models[models.length - 1]!.id : null;
}

/** How long the ping may take before we stop waiting. A turn that says "ok"
 *  takes a couple of seconds; a minute means something is wrong with it, not
 *  that patience will help. */
const REFRESH_TIMEOUT_MS = 60_000;

/**
 * Run a minimal Codex turn so the rate-limit snapshot on disk is current.
 *
 * Single-flighted: several open tabs firing their on-load trigger at once is
 * the normal case, and each one spawning its own turn would multiply the cost
 * by the number of windows somebody happens to have open.
 */
export async function refreshCodexUsage(): Promise<{ ok: boolean; error?: string }> {
  if (!CODEX_ENABLED()) return { ok: false, error: "Codex is not available on this machine" };
  return singleFlight("codex-usage-refresh", async () => {
    // codexModels() is synchronous and already exported (server/src/codex.ts:127).
    const model = usageRefreshModel(codexModels());
    const args = ["exec", "--sandbox", "read-only"];
    if (model) args.push("--model", model);
    args.push("Reply with the single word: ok");
    const proc = Bun.spawn(["codex", ...args], {
      stdout: "ignore", stderr: "ignore", timeout: REFRESH_TIMEOUT_MS,
    });
    const code = await proc.exited;
    // The turn's OUTPUT is worthless — the point is the rate_limits it wrote
    // on its way past. Drop the cache so the next read sees the new file.
    __resetCodexUsageCache();
    return code === 0 ? { ok: true } : { ok: false, error: `codex exited ${code}` };
  });
}
