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
/*
 * Fifteen minutes, and this is the only cadence that reaches Anthropic — the
 * browser polls this server, which costs nothing and is why it can stay quick.
 *
 * The endpoint limits per account and limits hard: measured on one machine,
 * three calls inside four minutes was enough to be answered 429, with every
 * Claude Code session open at the time drawing on the same budget. What is
 * being asked about is a five-hour window and a seven-day one, so a
 * fifteen-minute picture of them is the same picture. A shorter TTL buys no
 * accuracy — it buys a larger share of a budget that isn't ours to spend.
 */
const TTL = 15 * 60_000;
// On failure, retry sooner than the happy path — but back off, because the
// most common failure here is a 429 and retrying every ten seconds against a
// rate limiter is what *keeps* you rate-limited. Doubling from 10s to a 5m
// ceiling turns a self-inflicted outage into a blip.
const ERROR_TTL = 10_000;
const ERROR_TTL_MAX = 5 * 60_000;
let failures = 0;
/** Honour an explicit Retry-After over our own guess — the server knows. */
let retryAfterMs = 0;
/**
 * How long a good reading stays worth showing once fetching starts failing.
 *
 * Half an hour for an ordinary failure. A full day when the failure is a 429,
 * because a 429 from this endpoint is not an outage — it is a busy Tuesday. The
 * limit is per account and shared with every Claude Code session on the
 * machine, so throttling arrives in bursts all day while the numbers being
 * throttled barely move. Expiring the reading after half an hour swapped two
 * true, slightly old percentages for the word "Rate-limited", which is the one
 * thing that strip can say that tells you nothing at all about your plan.
 */
const STALE_MAX = 30 * 60_000;
const RATE_LIMITED_STALE_MAX = 24 * 3_600_000;

/** Exported for the test that would otherwise have to wait a day to run. */
export const staleWindowFor = (status: number | null): number =>
  status === 429 ? RATE_LIMITED_STALE_MAX : STALE_MAX;

let lastGood: UsagePayload | null = null;

/** Carries the status through the throw, so a failure is classified from what
 *  the server said rather than pattern-matched back out of a message. */
class UsageHttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

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

/**
 * @param now Injected clock. Every decision here is a function of time — the
 *   TTL, the backoff, how long a reading outlives the fetch that got it — and a
 *   day-long window is not something a test can wait for.
 */
export async function getUsage(now: number = Date.now()): Promise<UsagePayload> {
  const backoff = Math.max(
    retryAfterMs,
    Math.min(ERROR_TTL_MAX, ERROR_TTL * 2 ** Math.max(0, failures - 1)),
  );
  const ttl = cache?.available ? TTL : backoff;
  if (cache && now - cacheAt < ttl) return cache;

  const t = await token();
  if (!t) {
    cache = degrade(now, "no credentials", null);
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
      throw new UsageHttpError(r.status);
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
    cache = degrade(now, String(e), e instanceof UsageHttpError ? e.status : null);
  }
  cacheAt = now;
  return cache;
}

/** On failure, fall back to the last good reading (marked with its original
 *  fetched_at) instead of hiding the meters; only report unavailable when the
 *  stale data is too old to be meaningful — which depends on why the fetch
 *  failed, see `staleWindowFor`. The error travels with the stale payload so
 *  the client can say how old the numbers are rather than implying they are
 *  live. */
function degrade(now: number, error: string, status: number | null): UsagePayload {
  if (lastGood && now - lastGood.fetched_at < staleWindowFor(status)) {
    return { ...lastGood, error };
  }
  return { available: false, fetched_at: now, error };
}
