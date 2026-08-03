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
// Read when the module loads, so both have to be set before the import below.
// The config home is a scratch directory on purpose: the module refuses to read
// or write a real reading under `bun test` unless pointed at one.
process.env.CLAUDE_CREDENTIALS = creds;
process.env.XDG_CONFIG_HOME = dir;
const onDisk = join(dir, "agentglass", "usage-last.json");

let usage: typeof import("../src/usage.ts");
const realFetch = globalThis.fetch;
/** What the endpoint answers next. */
let reply: () => Response = () => new Response("{}", { status: 500 });
/** How many times the endpoint was actually asked — the point of the free feed
 *  is that accepting one means not asking. */
let calls = 0;

beforeAll(async () => {
  globalThis.fetch = (async () => { calls++; return reply(); }) as unknown as typeof fetch;
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

// A grace window measured in hours is worth nothing if the reading it protects
// dies with the process, and this process restarts every time the desktop app
// is rebuilt. Measured on the machine this was written for: a rebuild at 13:51,
// and by 13:59 the strip read "Rate-limited" while the endpoint answered 429 to
// every attempt to earn the first reading back. Starting blind into a burst of
// 429s is unrecoverable by definition — there is nothing to show and no way to
// get anything to show.
describe("across a restart", () => {
  const T2 = T0 + 40 * HOUR;

  test("a good reading is written down, and a restart still has it", async () => {
    usage.__test_forgetEverything();
    reply = ok(7, 44);
    expect((await usage.getUsage(T2)).available).toBe(true);
    expect(await Bun.file(onDisk).json()).toMatchObject({ available: true, fetched_at: T2 });

    // The restart itself: everything this process knew is gone, and the
    // endpoint is in no mood to replace it.
    usage.__test_forgetEverything();
    reply = failing(429);
    const u = await usage.getUsage(T2 + 5 * MIN);
    expect(u.available).toBe(true);
    expect(u.five_hour?.utilization).toBe(7);
    expect(u.seven_day?.utilization).toBe(44);
    // Dated to the read it came from, not to the boot that found it, so the
    // strip still says how old it is.
    expect(u.fetched_at).toBe(T2);
    expect(u.error).toContain("429");
  });

  test("a reading from days ago is not resurrected", async () => {
    // The file is not a licence to show anything forever: what comes off disk
    // faces the same staleness rules as what never left memory.
    usage.__test_forgetEverything();
    reply = failing(429);
    expect((await usage.getUsage(T2 + 3 * 24 * HOUR)).available).toBe(false);
  });

  test("a half-written or hand-edited file starts blind rather than inventing one", async () => {
    // Every one of these is something a crash mid-write or a curious person
    // with an editor can leave behind.
    for (const junk of ["", "{", "{}", "null", '{"available":false}', '{"available":true}', '{"available":true,"fetched_at":"soon"}']) {
      await Bun.write(onDisk, junk);
      usage.__test_forgetEverything();
      reply = failing(429);
      expect((await usage.getUsage(T2 + 4 * 24 * HOUR)).available).toBe(false);
    }
  });
});

// The reading that costs nothing.
//
// Claude Code pipes `rate_limits` to its statusLine command on every turn,
// carried on the Messages API response it already made. hooks/statusline.sh
// forwards it here, which is the same account-wide numbers the endpoint above
// answers with — except this copy is free, and the endpoint answers 429 to a
// third call inside four minutes.
describe("a reading handed over by a live session", () => {
  const T3 = T0 + 60 * HOUR;
  const statusline = (five: unknown, seven?: unknown) => ({
    model: { display_name: "Opus" },
    rate_limits: { five_hour: five, seven_day: seven },
  });

  test("both windows, with the reset time the CLI sends", async () => {
    usage.__test_forgetEverything();
    // resets_at arrives as seconds since the epoch.
    const at = Math.floor((T3 + 3 * HOUR) / 1000);
    expect(usage.ingestStatusline(
      statusline({ used_percentage: 13, resets_at: at }, { used_percentage: 51 }), T3,
    )).toBe(true);

    calls = 0;
    const u = await usage.getUsage(T3);
    expect(u.available).toBe(true);
    expect(u.five_hour?.utilization).toBe(13);
    expect(u.five_hour?.remaining).toBe(87);
    expect(u.five_hour?.resets_at).toBe(new Date(at * 1000).toISOString());
    expect(u.seven_day?.utilization).toBe(51);
    // The whole point: nothing was asked of the endpoint.
    expect(calls).toBe(0);
  });

  test("accepting one postpones the next fetch by a full TTL", async () => {
    // Free numbers are a reason not to spend budget, not a reason to spend it
    // sooner. Ten minutes on, still nothing asked.
    calls = 0;
    reply = failing(429);
    expect((await usage.getUsage(T3 + 10 * MIN)).five_hour?.utilization).toBe(13);
    expect(calls).toBe(0);
  });

  test("it is what a restart finds", async () => {
    usage.__test_forgetEverything();
    calls = 0;
    reply = failing(429);
    const u = await usage.getUsage(T3 + 20 * MIN);
    expect(u.available).toBe(true);
    expect(u.five_hour?.utilization).toBe(13);
    expect(u.fetched_at).toBe(T3);
  });

  test("`utilization` is accepted as the endpoint's name for the same number", () => {
    usage.__test_forgetEverything();
    expect(usage.ingestStatusline(statusline({ utilization: 7 }), T3)).toBe(true);
  });

  test("a percentage outside 0..100 is clamped rather than drawn off the end", async () => {
    usage.__test_forgetEverything();
    usage.ingestStatusline(statusline({ used_percentage: 140 }, { used_percentage: -3 }), T3);
    const u = await usage.getUsage(T3);
    expect(u.five_hour?.utilization).toBe(100);
    expect(u.seven_day?.utilization).toBe(0);
  });

  test("a reset time in milliseconds is not read as the year 58,000", async () => {
    usage.__test_forgetEverything();
    const ms = T3 + HOUR;
    usage.ingestStatusline(statusline({ used_percentage: 5, resets_at: ms }), T3);
    expect((await usage.getUsage(T3)).five_hour?.resets_at).toBe(new Date(ms).toISOString());

    // And an ISO string, should the schema ever drift to one.
    usage.__test_forgetEverything();
    usage.ingestStatusline(statusline({ used_percentage: 5, resets_at: "2026-08-05T12:00:00Z" }), T3);
    expect((await usage.getUsage(T3)).five_hour?.resets_at).toBe("2026-08-05T12:00:00.000Z");
  });

  test("a payload with nothing in it changes nothing", async () => {
    usage.__test_forgetEverything();
    for (const junk of [
      null, undefined, {}, { rate_limits: null }, { rate_limits: {} },
      statusline(undefined, undefined),
      statusline({ used_percentage: "lots" }),
      statusline({ resets_at: 123 }),
    ]) {
      expect(usage.ingestStatusline(junk, T3)).toBe(false);
    }
    // Nothing was accepted, so there is still no reading to show — the feed
    // cannot half-fill the meters with a payload it could not read. The file
    // has to be cleared for that to mean anything: a reading persisted earlier
    // would be restored here, correctly, and hide the very thing being asked.
    await Bun.write(onDisk, "");
    usage.__test_forgetEverything();
    reply = failing(429);
    expect((await usage.getUsage(T3)).available).toBe(false);
  });
});
