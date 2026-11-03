/*
 * The OpenCode console's usage limits, read with a personal API key.
 *
 * The route is undocumented. `/zen/go/v1/usage` answers 401 with no key (it
 * exists) and takes a Bearer key; `/api/experimental/usage/limits` was tried
 * first and answers 404. The body is read narrowly for the same reason: a percentage, or a
 * used/limit pair, under `windows` or `limits`, each named by the same headers
 * the console page uses. A 200 in a shape this does not recognise is said out
 * loud and is never turned into a number — a gauge at 0% because parsing failed
 * is the bug this whole feature exists to avoid.
 *
 * A 403 is the one answer worth its own sentence: the key exists and is not
 * allowed to read budgets. That is a permission to add, not a key to guess at.
 */
import type { QuotaWindow } from "../../shared/types.ts";

export const LIMITS_URL = "https://opencode.ai/zen/go/v1/usage";

export type LimitsReading =
  | { status: "ok"; windows: QuotaWindow[] }
  | { status: "forbidden"; reason: string }
  | { status: "unavailable"; reason: string };

export const FORBIDDEN =
  "OpenCode's console refused this key: this key needs Budgets: Read. "
  + "Create the key again with Budgets = Read, then paste it in Settings › Agent engines.";

const unavailable = (reason: string): LimitsReading => ({ status: "unavailable", reason });

const WINDOWS = [
  { minutes: 300, label: "5h" },
  { minutes: 10080, label: "weekly" },
  { minutes: 43200, label: "monthly" },
] as const;

function minutesOf(name: string): number | null {
  if (/5\s*-?\s*h(our)?/i.test(name)) return 300;
  if (/week/i.test(name)) return 10080;
  if (/month/i.test(name)) return 43200;
  return null;
}

const percentOf = (r: Record<string, unknown>): number | null => {
  const pct = Number(r.usedPercent ?? r.percent ?? r.utilization);
  if (Number.isFinite(pct)) return Math.max(0, Math.min(100, pct));
  const used = Number(r.used);
  const limit = Number(r.limit ?? r.cap);
  if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
    return Math.max(0, Math.min(100, (used / limit) * 100));
  }
  return null;
};

/**
 * The windows in an answer, or null when the shape is not one this app knows.
 * All three are required: a plan that quietly lost a window is a page that
 * changed shape, and two numbers and a guess is worse than saying so.
 */
export function parseUsageLimits(doc: unknown): QuotaWindow[] | null {
  const body = (doc ?? {}) as Record<string, unknown>;
  // The Go route answers { usage: { rolling, weekly, monthly } }, each with a percent and resetsAt.
  const u = body.usage as Record<string, unknown> | undefined;
  const named = u && typeof u === "object"
    ? [["5h", u.rolling], ["weekly", u.weekly], ["monthly", u.monthly]]
      .filter(([, v]) => v && typeof v === "object")
      .map(([label, v]) => ({ label, ...(v as object) }))
    : undefined;
  const rows = named?.length ? named : [body.windows, body.limits].find(Array.isArray) as unknown[] | undefined;
  if (!rows) return null;
  const windows: QuotaWindow[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = String(r.label ?? r.window ?? r.name ?? "");
    const minutes = typeof r.minutes === "number" ? r.minutes : minutesOf(name);
    const pct = percentOf(r);
    if (minutes === null || pct === null) continue;
    const reset = typeof (r.resetsAt ?? r.reset) === "number" ? new Date(Number(r.resetsAt ?? r.reset) * (Number(r.resetsAt ?? r.reset) < 1e12 ? 1000 : 1)).toISOString() : r.resetsAt ?? r.reset;
    windows.push({
      label: WINDOWS.find((w) => w.minutes === minutes)?.label ?? name,
      minutes,
      usedPercent: Math.round(pct * 10) / 10,
      resetsAt: typeof reset === "string" && reset ? reset : null,
    });
  }
  const found = new Map(windows.map((w) => [w.minutes, w]));
  if (found.size !== WINDOWS.length) return null;
  return WINDOWS.map((w) => found.get(w.minutes)!);
}

/** One read. The key goes in the header and nowhere else. */
export async function readUsageLimits(key: string, fetchImpl: typeof fetch = fetch): Promise<LimitsReading> {
  let res: Response;
  try {
    res = await fetchImpl(LIMITS_URL, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return unavailable(`Could not reach OpenCode's console (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (res.status === 401) {
    return unavailable("OpenCode's console did not accept this key. Create a new one and paste it in Settings › Agent engines.");
  }
  if (res.status === 403) return { status: "forbidden", reason: FORBIDDEN };
  if (!res.ok) return unavailable(`OpenCode's console answered ${res.status}; nothing was read.`);
  let doc: unknown;
  try { doc = await res.json(); } catch { return unavailable("OpenCode's console answered with something that was not JSON."); }
  const windows = parseUsageLimits(doc);
  if (!windows) {
    return unavailable(
      "OpenCode's console answered, but not in a shape this app knows. "
      + "The usage route is undocumented; its address needs confirming before the panel can draw it.",
    );
  }
  return { status: "ok", windows };
}
