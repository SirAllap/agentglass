// A plugin that switches the Claude login rewrites the credentials file. The
// cached plan reading belongs to the login that was in it: measured by hand,
// the old login's percentages stayed on screen for the whole fifteen-minute TTL
// under the new login's chip. Time is injected, the endpoint is a stub, and the
// credentials are a scratch file: nothing here reaches ~/.claude or Anthropic.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-usage-key-"));
const creds = join(dir, "credentials.json");
const was = { creds: process.env.CLAUDE_CREDENTIALS, xdg: process.env.XDG_CONFIG_HOME };
const realFetch = globalThis.fetch;
let usage: typeof import("../src/usage.ts");
let reply: () => Response | Promise<Response>;
let calls = 0;

const login = (token: string, mtime: number) => {
  writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  utimesSync(creds, mtime, mtime);
};
const ok = (five: number) => () => new Response(JSON.stringify({
  five_hour: { utilization: five, resets_at: "2026-08-03T11:39:59Z" },
  seven_day: { utilization: 40, resets_at: "2026-08-05T12:59:59Z" },
}), { status: 200 });

const T0 = 1_700_000_000_000;
const MIN = 60_000;

beforeAll(async () => {
  process.env.CLAUDE_CREDENTIALS = creds;
  process.env.XDG_CONFIG_HOME = dir;
  login("acme-a-token", 1_700_000_000);
  globalThis.fetch = (async () => { calls++; return reply(); }) as unknown as typeof fetch;
  usage = await import("../src/usage.ts");
  usage.__test_forgetEverything();
});

afterAll(() => {
  usage.__test_forgetEverything();
  globalThis.fetch = realFetch;
  for (const [k, v] of [["CLAUDE_CREDENTIALS", was.creds], ["XDG_CONFIG_HOME", was.xdg]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const step = story();

describe("the reading follows the login in the credentials file", () => {
  step("an unchanged file is served from the cache", async () => {
    reply = ok(10);
    expect((await usage.getUsage(T0)).five_hour?.utilization).toBe(10);
    reply = ok(99);
    expect((await usage.getUsage(T0 + MIN)).five_hour?.utilization).toBe(10);
    expect(calls).toBe(1);
  });

  step("a rewritten file is read again at once, inside the TTL", async () => {
    login("acme-b-token-longer", 1_700_000_100);
    const u = await usage.getUsage(T0 + 2 * MIN);
    expect(u.five_hour?.utilization).toBe(99);
    expect(calls).toBe(2);
  });

  step("a rewritten file while the endpoint refuses keeps the last good reading: a renewed token is not a new login", async () => {
    login("acme-a-token", 1_700_000_200);
    reply = () => new Response("{}", { status: 429 });
    const u = await usage.getUsage(T0 + 3 * MIN);
    expect(u.available).toBe(true);
    expect(u.five_hour?.utilization).toBe(99);
    expect(u.error).toContain("429");
  });

  step("the backoff earned is kept when the file changes again, not paid back at once", async () => {
    login("acme-b-token-longer", 1_700_000_300);
    reply = ok(7);
    const before = calls;
    const u = await usage.getUsage(T0 + 3 * MIN + 1);
    expect(calls).toBe(before);
    expect(u.error).toContain("429");
    // A stale reading served with its error is held for the full TTL, as before.
    expect((await usage.getUsage(T0 + 3 * MIN + 11_000)).error).toContain("429");
    expect(calls).toBe(before);
    expect((await usage.getUsage(T0 + 19 * MIN)).five_hour?.utilization).toBe(7);
    expect(calls).toBe(before + 1);
  });

  step("clearUsageCache drops the reading for a switch the file cannot show", async () => {
    reply = ok(55);
    const before = calls;
    await usage.getUsage(T0 + 20 * MIN);
    expect(calls).toBe(before);
    usage.clearUsageCache();
    expect((await usage.getUsage(T0 + 20 * MIN)).five_hour?.utilization).toBe(55);
    expect(calls).toBe(before + 1);
  });
});

describe("a plugin saying the active login changed", () => {
  const list = (active: string) => ({
    provider: "anthropic",
    accounts: ["acme-a", "acme-b"].map((id) => ({ id, label: id, plan: "max", colour: "neutral", active: id === active, storage: "file" })),
  });
  const c = { accounts: ["anthropic"] } as import("../../shared/pluginUi.ts").Contributes;

  test("drops the reading only when the active id moves, never on the first post", async () => {
    const { setAccounts, forgetAccounts } = await import("../src/accounts.ts");
    usage.__test_forgetEverything();
    reply = ok(20);
    await usage.getUsage(T0);
    const base = calls;
    expect(setAccounts("acme-plugin", c, list("acme-a")).ok).toBe(true);
    await usage.getUsage(T0 + MIN);
    expect(calls).toBe(base);
    expect(setAccounts("acme-plugin", c, list("acme-a")).ok).toBe(true);
    await usage.getUsage(T0 + MIN);
    expect(calls).toBe(base);
    expect(setAccounts("acme-plugin", c, list("acme-b")).ok).toBe(true);
    await usage.getUsage(T0 + MIN);
    expect(calls).toBe(base + 1);
    forgetAccounts("acme-plugin");
  });
});

// What a plugin can do with the switch signal, and what a switch in the middle
// of a read can do to the cache. Each case starts from nothing.
const wait = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(10); };
const onDisk = join(dir, "agentglass", "usage-last.json");

describe("a login change cannot be used to get round the endpoint's limits", () => {
  const step2 = story();

  step2("a 429 with a Retry-After is still waited out after any number of switches", async () => {
    usage.__test_forgetEverything();
    login("acme-a-token", 1_700_001_000);
    calls = 0;
    reply = () => new Response("{}", { status: 429, headers: { "retry-after": "120" } });
    expect((await usage.getUsage(T0)).available).toBe(false);
    expect(calls).toBe(1);
    for (let i = 1; i <= 4; i++) {
      usage.clearUsageCache();
      expect((await usage.getUsage(T0 + i * 5_000)).error).toContain("login");
    }
    expect(calls).toBe(1);
    reply = ok(5);
    expect((await usage.getUsage(T0 + 121_000)).five_hour?.utilization).toBe(5);
    expect(calls).toBe(2);
  });

  step2("with no failure behind it, a flapping list still costs one read a minute", async () => {
    usage.__test_forgetEverything();
    calls = 0;
    reply = ok(8);
    await usage.getUsage(T0);
    usage.clearUsageCache();
    await usage.getUsage(T0 + 10_000);
    expect(calls).toBe(2);
    for (let i = 1; i <= 3; i++) { usage.clearUsageCache(); await usage.getUsage(T0 + 10_000 + i * 10_000); }
    expect(calls).toBe(2);
    usage.clearUsageCache();
    await usage.getUsage(T0 + 71_000);
    expect(calls).toBe(3);
  });
});

describe("a switch while a read is in flight", () => {
  const step3 = story();

  step3("the answer of a read that started under the old login is not stored", async () => {
    usage.__test_forgetEverything();
    login("acme-a-token", 1_700_002_000);
    calls = 0;
    // The plugin rewrites the file while the endpoint is still answering, and the
    // popover's own poll looks at the usage in that moment.
    reply = async () => { login("acme-b-token-longer", 1_700_002_100); await usage.peekUsage(); return ok(80)(); };
    await usage.getUsage(T0);
    expect(await usage.peekUsage()).toBeNull();
    reply = ok(15);
    expect((await usage.getUsage(T0 + 2 * MIN)).five_hour?.utilization).toBe(15);
    expect(calls).toBe(2);
  });
});

describe("a switch while the server is down", () => {
  const step4 = story();

  step4("the reading on disk is for the login it was taken under", async () => {
    usage.__test_forgetEverything();
    login("acme-a-token", 1_700_003_000);
    reply = ok(33);
    await usage.getUsage(T0);
    await wait(() => (Bun.file(onDisk).size ?? 0) > 0);
    expect(await Bun.file(onDisk).json()).toHaveProperty("loginKey");

    // Restart on the same login: the reading is the stale fallback it is meant to be.
    usage.__test_forgetEverything();
    reply = () => new Response("{}", { status: 429 });
    expect((await usage.getUsage(T0 + 5 * MIN)).five_hour?.utilization).toBe(33);

    // Restart after the file was rewritten by a switch: nothing to fall back on.
    login("acme-b-token-longer", 1_700_003_100);
    usage.__test_forgetEverything();
    expect((await usage.getUsage(T0 + 10 * MIN)).available).toBe(false);
  });
});

describe("a reading fed by a session after the file changed", () => {
  test("is kept: syncLogin first, so the next peek does not wipe it as the old login's", async () => {
    usage.__test_forgetEverything();
    login("acme-a-token", 1_700_004_000);
    reply = ok(10);
    await usage.getUsage(T0);
    login("acme-b-token-longer", 1_700_004_100);
    await usage.syncLogin();
    expect(usage.ingestStatusline({ rate_limits: { five_hour: { used_percentage: 20 }, seven_day: { used_percentage: 30 } } }, T0 + MIN)).toBe(true);
    expect((await usage.peekUsage())?.five_hour?.utilization).toBe(20);
  });

  test("the route calls it before the ingest", async () => {
    const src = await Bun.file(join(import.meta.dir, "../src/index.ts")).text();
    const route = src.slice(src.indexOf('pathname === "/statusline"'));
    expect(route.indexOf("await syncLogin()")).toBeGreaterThan(0);
    expect(route.indexOf("await syncLogin()")).toBeLessThan(route.indexOf("ingestStatusline(body)"));
  });
});
