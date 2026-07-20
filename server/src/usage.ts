// Account usage: fetches the 5-hour + weekly rate-limit windows from Anthropic's
// OAuth usage endpoint using the local Claude Code credentials. Localhost-only —
// the token never leaves this machine except to api.anthropic.com (its purpose).
//
// This uses an unofficial endpoint (the one Claude Code's `/usage` calls). It may
// change; failures degrade gracefully to { available: false }.
import { homedir } from "os";
import { join } from "path";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CRED_PATH = process.env.CLAUDE_CREDENTIALS || join(homedir(), ".claude", ".credentials.json");

export interface UsageWindow {
  utilization: number; // 0..100 used
  remaining: number; // 0..100 left
  resets_at: string | null;
}
export interface UsagePayload {
  available: boolean;
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  fetched_at: number;
  error?: string;
}

let cache: UsagePayload | null = null;
let cacheAt = 0;
// Matched to the client's poll interval. A shorter TTL here just means the
// first of several open surfaces pays a network call the others don't need —
// and against a rate-limited endpoint, every avoidable call is one that can
// cost the whole feature.
const TTL = 5 * 60_000;
// On failure, retry sooner than the happy path — but back off, because the
// most common failure here is a 429 and retrying every ten seconds against a
// rate limiter is what *keeps* you rate-limited. Doubling from 10s to a 5m
// ceiling turns a self-inflicted outage into a blip.
const ERROR_TTL = 10_000;
const ERROR_TTL_MAX = 5 * 60_000;
let failures = 0;
/** Honour an explicit Retry-After over our own guess — the server knows. */
let retryAfterMs = 0;
const STALE_MAX = 30 * 60_000; // stop serving stale data after 30m
let lastGood: UsagePayload | null = null;

async function token(): Promise<string | null> {
  try {
    const c = (await Bun.file(CRED_PATH).json()) as any;
    return c?.claudeAiOauth?.accessToken ?? c?.accessToken ?? null;
  } catch {
    return null;
  }
}

function win(w: any): UsageWindow | undefined {
  if (!w || typeof w.utilization !== "number") return undefined;
  return {
    utilization: Math.round(w.utilization),
    remaining: Math.max(0, Math.round(100 - w.utilization)),
    resets_at: w.resets_at ?? null,
  };
}

export async function getUsage(): Promise<UsagePayload> {
  const now = Date.now();
  const backoff = Math.max(
    retryAfterMs,
    Math.min(ERROR_TTL_MAX, ERROR_TTL * 2 ** Math.max(0, failures - 1)),
  );
  const ttl = cache?.available ? TTL : backoff;
  if (cache && now - cacheAt < ttl) return cache;

  const t = await token();
  if (!t) {
    cache = degrade(now, "no credentials");
    cacheAt = now;
    return cache;
  }
  try {
    const r = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${t}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "agentglass",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      // A 429 usually carries how long to wait. Believing it beats guessing,
      // and ignoring it is how a client earns a longer ban.
      const ra = Number(r.headers.get("retry-after"));
      retryAfterMs = r.status === 429 && Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, ERROR_TTL_MAX) : 0;
      throw new Error(`HTTP ${r.status}`);
    }
    const j = (await r.json()) as any;
    cache = {
      available: true,
      five_hour: win(j.five_hour),
      seven_day: win(j.seven_day),
      fetched_at: now,
    };
    lastGood = cache;
    failures = 0;
    retryAfterMs = 0;
  } catch (e) {
    failures++;
    cache = degrade(now, String(e));
  }
  cacheAt = now;
  return cache;
}

/** On failure, fall back to the last good reading (marked with its original
 *  fetched_at) instead of hiding the meters; only report unavailable when the
 *  stale data is too old to be meaningful. */
function degrade(now: number, error: string): UsagePayload {
  if (lastGood && now - lastGood.fetched_at < STALE_MAX) {
    return { ...lastGood, error };
  }
  return { available: false, fetched_at: now, error };
}
