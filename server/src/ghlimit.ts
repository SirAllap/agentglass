/*
 * What GitHub last said about the GraphQL budget, kept from answers the app
 * already receives.
 *
 * Every pull-request read is a GraphQL request against one hourly budget, and
 * the answer to each carries `x-ratelimit-remaining` / `x-ratelimit-reset`
 * (the HTTP path, `ghGraphql`). Reading them costs nothing: no request is made
 * to learn the budget. When GitHub answers "limit reached" the app stops
 * asking until the reset, and the cards keep showing the last list read.
 *
 * Ceiling: one GraphQL budget per process (one account). The `gh` subprocess
 * path prints no headers, so a limit seen there is held for a minute at a time
 * (or until the last reset this process saw, if that is still ahead).
 */

export interface GhRate {
  limit: number;
  remaining: number;
  /** Epoch ms when the budget refills; 0 when GitHub never said. */
  resetAt: number;
  /** True while a limit answer is in force and its reset has not passed. */
  limited: boolean;
  /** Epoch ms of the answer this was taken from. */
  seenAt: number;
}

/** GitHub's own words for "slow down" on a failed call. */
export const LIMIT_TEXT = /rate limit|RATE_LIMIT|HTTP 429|abuse detection/i;
/** With no reset known, ask again after this long. */
const BLIND_HOLD_MS = 60_000;

let last: GhRate | null = null;

export function resetRate(): void { last = null; }

type Headers = { get(name: string): string | null };

/** Take the budget from a response's headers. A 403/429 that says "slow down" holds. */
export function noteHeaders(h: Headers, status: number, now = Date.now()): void {
  const remaining = Number(h.get("x-ratelimit-remaining"));
  const limit = Number(h.get("x-ratelimit-limit"));
  const reset = Number(h.get("x-ratelimit-reset"));
  const retryAfter = Number(h.get("retry-after"));
  const haveBudget = h.get("x-ratelimit-remaining") !== null && Number.isFinite(remaining);
  const known = Number.isFinite(reset) && reset > 0 ? reset * 1000 : last?.resetAt ?? 0;
  const secondary = (status === 403 || status === 429) && Number.isFinite(retryAfter) && retryAfter > 0;
  const spent = haveBudget && remaining <= 0 && known > now;
  if (!haveBudget && !secondary && status !== 429) return;
  const limited = secondary || spent || status === 429;
  last = {
    limit: Number.isFinite(limit) && limit > 0 ? limit : last?.limit ?? 0,
    remaining: haveBudget ? remaining : limited ? 0 : last?.remaining ?? 0,
    resetAt: secondary ? now + retryAfter * 1000 : limited && known <= now ? now + BLIND_HOLD_MS : known,
    limited,
    seenAt: now,
  };
}

/** A GraphQL body that says RATE_LIMITED (GitHub answers some of these with a 200). */
export function noteBody(body: unknown, now = Date.now()): void {
  const errors = (body as { errors?: { type?: string }[] } | null)?.errors;
  if (Array.isArray(errors) && errors.some((e) => e?.type === "RATE_LIMITED")) noteLimitedBlind(now);
}

/** A limit seen with no headers (the `gh` subprocess): hold to the last known reset, or a minute. */
export function noteLimitedBlind(now = Date.now()): void {
  const resetAt = last && last.resetAt > now ? last.resetAt : now + BLIND_HOLD_MS;
  last = { limit: last?.limit ?? 0, remaining: 0, resetAt, limited: true, seenAt: now };
}

/** The `rateLimit` GraphQL field, when a query carries it. */
export function noteField(rl: { limit?: number; remaining?: number; resetAt?: string } | null | undefined, now = Date.now()): void {
  if (!rl || typeof rl.remaining !== "number") return;
  const resetAt = Date.parse(rl.resetAt ?? "") || last?.resetAt || 0;
  last = { limit: rl.limit ?? last?.limit ?? 0, remaining: rl.remaining, resetAt, limited: rl.remaining <= 0 && resetAt > now, seenAt: now };
}

/** Epoch ms the app must not ask GitHub (GraphQL) before; null when it may. */
export function heldUntil(now = Date.now()): number | null {
  return last?.limited && last.resetAt > now ? last.resetAt : null;
}

/** What the panel shows, or null before any answer was seen. */
export function rateView(now = Date.now()): GhRate | null {
  if (!last) return null;
  return { ...last, limited: !!last.limited && last.resetAt > now };
}
