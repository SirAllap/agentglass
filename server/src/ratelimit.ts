// Fixed-window rate limiter for the unauthenticated intake routes, so a runaway
// or hostile local client can't flood the DB and the broadcast fan-out. The
// window is generous — normal hook/OTel traffic never approaches it — and both
// knobs are env-tunable.
const WINDOW_MS = Math.max(1000, Number(process.env.AGENTGLASS_RATE_WINDOW_MS) || 10_000);
const MAX = Math.max(10, Number(process.env.AGENTGLASS_RATE_MAX) || 300);

const buckets = new Map<string, { n: number; reset: number }>();

/** Count one hit for `key`; false once it exceeds MAX within the window. */
export function rateOk(key: string): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.reset) {
    buckets.set(key, { n: 1, reset: now + WINDOW_MS });
    return true;
  }
  if (b.n >= MAX) return false;
  b.n++;
  return true;
}

// Evict expired buckets so a churn of distinct keys can't grow the map without
// bound. unref so this timer never keeps the process alive on its own.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now >= b.reset) buckets.delete(k);
}, WINDOW_MS);
(sweep as { unref?: () => void }).unref?.();
