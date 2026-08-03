// The plan meters, and the failure they are actually going to meet.
//
// /api/oauth/usage limits per account, and every Claude Code session on the
// machine draws on the same budget — measured on one: three calls inside four
// minutes was enough to be answered 429, while the numbers being asked about
// had not moved. So a 429 is not an outage worth reporting, it is the weather.
// What this file pins is what the meters do while it blows: keep the last true
// reading, or blank out and say "Rate-limited" at somebody who only wanted to
// know how much of their week was left.
//
// Time is injected rather than waited for — the rate-limited window is a day
// long. The module holds one process-wide cache by design, so these run as a
// single story in order rather than as independent cases.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-plan-usage-"));
const creds = join(dir, "credentials.json");
writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }));
// Read when the module loads, so it has to be set before the import below.
process.env.CLAUDE_CREDENTIALS = creds;

let usage: typeof import("../src/usage.ts");
const realFetch = globalThis.fetch;
/** What the endpoint answers next. */
let reply: () => Response = () => new Response("{}", { status: 500 });

beforeAll(async () => {
  globalThis.fetch = (async () => reply()) as unknown as typeof fetch;
  usage = await import("../src/usage.ts");
});
afterAll(() => { globalThis.fetch = realFetch; });

const ok = (fiveHour: number, sevenDay: number) => () =>
  new Response(JSON.stringify({
    five_hour: { utilization: fiveHour, resets_at: "2026-08-03T11:39:59Z" },
    seven_day: { utilization: sevenDay, resets_at: "2026-08-05T12:59:59Z" },
  }), { status: 200 });
const failing = (code: number) => () => new Response("{}", { status: code });

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_700_000_000_000;

describe("how long a reading outlives the fetch that got it", () => {
  test("a day for a 429, half an hour for anything else", () => {
    expect(usage.staleWindowFor(429)).toBe(24 * HOUR);
    expect(usage.staleWindowFor(500)).toBe(30 * MIN);
    // No status at all is a network error — nothing says it will pass quickly.
    expect(usage.staleWindowFor(null)).toBe(30 * MIN);
    // And a dead token is worth admitting to rather than papering over for a
    // day: those numbers will never refresh until somebody logs in again.
    expect(usage.staleWindowFor(401)).toBe(30 * MIN);
  });
});

describe("through a burst of 429s", () => {
  test("a good fetch reads both windows", async () => {
    reply = ok(13, 51);
    const u = await usage.getUsage(T0);
    expect(u.available).toBe(true);
    expect(u.five_hour?.utilization).toBe(13);
    expect(u.seven_day?.utilization).toBe(51);
    expect(u.error).toBeUndefined();
  });

  test("a 429 keeps the numbers, and dates them to when they were read", async () => {
    reply = failing(429);
    // Past the TTL, so this really does go to the network and really does fail.
    const u = await usage.getUsage(T0 + 16 * MIN);
    expect(u.available).toBe(true);
    expect(u.five_hour?.utilization).toBe(13);
    expect(u.seven_day?.utilization).toBe(51);
    // Dated to the read, not to now. This is the whole reason the strip can say
    // "40m old" instead of implying the number is live.
    expect(u.fetched_at).toBe(T0);
    expect(u.error).toContain("429");
  });

  test("still keeping them most of a day later", async () => {
    reply = failing(429);
    const u = await usage.getUsage(T0 + 20 * HOUR);
    expect(u.available).toBe(true);
    expect(u.seven_day?.utilization).toBe(51);
    expect(u.fetched_at).toBe(T0);
  });

  test("but not past the day — at some point they really are wrong", async () => {
    reply = failing(429);
    const u = await usage.getUsage(T0 + 25 * HOUR);
    expect(u.available).toBe(false);
    expect(u.error).toContain("429");
  });
});

describe("an ordinary failure is not given a day", () => {
  const T1 = T0 + 26 * HOUR;

  test("a 500 shortly after a good read still shows it", async () => {
    reply = ok(20, 60);
    expect((await usage.getUsage(T1)).available).toBe(true);
    reply = failing(500);
    const u = await usage.getUsage(T1 + 16 * MIN);
    expect(u.available).toBe(true);
    expect(u.five_hour?.utilization).toBe(20);
  });

  test("and stops once the reading is half an hour old", async () => {
    reply = failing(500);
    const u = await usage.getUsage(T1 + 32 * MIN);
    expect(u.available).toBe(false);
  });
});
