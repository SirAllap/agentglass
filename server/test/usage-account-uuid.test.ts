// A renewed OAuth token and a login changed by hand both rewrite the
// credentials file, and the stat cannot tell them apart. Claude Code's own
// config names the login by an account uuid; that one field, and nothing else
// in the file, is what separates the two. Time is injected, the endpoint is a
// stub, and both files are scratch files: nothing here reaches ~/.claude,
// ~/.claude.json or Anthropic.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-usage-uuid-"));
const creds = join(dir, "credentials.json");
const cfg = join(dir, "claude-config.json");
const keys = ["CLAUDE_CREDENTIALS", "CLAUDE_CONFIG_JSON", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"] as const;
const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
let usage: typeof import("../src/usage.ts");
let reply: () => Response | Promise<Response>;
let calls = 0;

// Invented values; the uuid is the only one the code may keep.
const U1 = "00000000-0000-4000-8000-0000000000a1";
const U2 = "00000000-0000-4000-8000-0000000000b2";
const EMAIL = "someone@acme-a.example.com";
const SECRET = "orbit-fixture-needle-1";

const login = (token: string, mtime: number) => {
  writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  utimesSync(creds, mtime, mtime);
};
const account = (uuid: string) => writeFileSync(cfg, JSON.stringify({
  oauthAccount: { accountUuid: uuid, emailAddress: EMAIL, displayName: "Acme A", organizationUuid: "org-acme" },
  primaryApiKey: SECRET,
  projects: { "/work/acme": { history: ["a private prompt"] } },
}));
const ok = (five: number) => () => new Response(JSON.stringify({
  five_hour: { utilization: five, resets_at: "2026-08-03T11:39:59Z" },
  seven_day: { utilization: 40, resets_at: "2026-08-05T12:59:59Z" },
}), { status: 200 });
const refuse = () => new Response("{}", { status: 429, headers: { "retry-after": "120" } });

const T0 = 1_700_000_000_000;
const MIN = 60_000;

beforeAll(async () => {
  process.env.CLAUDE_CREDENTIALS = creds;
  process.env.CLAUDE_CONFIG_JSON = cfg;
  process.env.XDG_CONFIG_HOME = dir;
  login("acme-a-token", 1_700_000_000);
  account(U1);
  globalThis.fetch = (async () => { calls++; return reply(); }) as unknown as typeof fetch;
  usage = await import("../src/usage.ts");
  usage.__test_forgetEverything();
});

afterAll(() => {
  usage.__test_forgetEverything();
  globalThis.fetch = realFetch;
  for (const k of keys) { if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]; }
  rmSync(dir, { recursive: true, force: true });
});

const step = story();

describe("the account uuid tells a renewal from a different login", () => {
  step("the same uuid and a rewritten credentials file is a renewal: the last good reading stays", async () => {
    reply = ok(10);
    expect((await usage.getUsage(T0)).five_hour?.utilization).toBe(10);
    login("acme-a-token-renewed", 1_700_000_100);
    reply = refuse;
    const u = await usage.getUsage(T0 + MIN);
    expect(u.available).toBe(true);
    expect(u.five_hour?.utilization).toBe(10);
    expect(u.error).toContain("429");
  });

  step("a different uuid drops the last good reading even while the endpoint refuses", async () => {
    const before = calls;
    account(U2);
    login("acme-b-token", 1_700_000_200);
    const u = await usage.getUsage(T0 + 2 * MIN);
    expect(u.available).toBe(false);
    expect(u.five_hour).toBeUndefined();
    // and the backoff earned is still waited out: the switch did not reset it
    expect(calls).toBe(before);
    reply = ok(3);
    expect((await usage.getUsage(T0 + 2 * MIN + 150_000)).five_hour?.utilization).toBe(3);
  });

  step("a login the config cannot name falls back to the old rule: a rewrite keeps the last good reading", async () => {
    writeFileSync(cfg, "{ not json");
    login("acme-c-token", 1_700_000_300);
    reply = refuse;
    const u = await usage.getUsage(T0 + 10 * MIN);
    expect(u.five_hour?.utilization).toBe(3);
  });
});

describe("only the uuid is read and kept", () => {
  test("nothing else of the file is retained, written, logged or served", async () => {
    usage.__test_forgetEverything();
    account(U1);
    login("acme-a-token", 1_700_001_000);
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    try {
      reply = ok(12);
      const u = await usage.getUsage(T0);
      login("acme-a-token-renewed", 1_700_001_100);
      const u2 = await usage.getUsage(T0 + MIN);
      await usage.syncLogin();
      expect(usage.__test_loginIdentity()).toBe(U1);
      const seen = JSON.stringify([u, u2, await usage.peekUsage(), spies.map((s) => s.mock.calls)]);
      for (const needle of [U1, EMAIL, SECRET, "Acme A", "org-acme", "private prompt"]) expect(seen).not.toContain(needle);
      await Bun.sleep(50);
      const disk = await Bun.file(join(dir, "agentglass", "usage-last.json")).text();
      for (const needle of [U1, EMAIL, SECRET, "org-acme", "private prompt"]) expect(disk).not.toContain(needle);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  test("under bun test only the injected path is read, never ~/.claude.json or CLAUDE_CONFIG_DIR", async () => {
    usage.__test_forgetEverything();
    delete process.env.CLAUDE_CONFIG_JSON;
    process.env.CLAUDE_CONFIG_DIR = dir;
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: U2 } }));
    try {
      reply = ok(1);
      await usage.getUsage(T0);
      expect(usage.__test_loginIdentity()).toBeNull();
    } finally {
      process.env.CLAUDE_CONFIG_JSON = cfg;
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  test("a path outside the scratch directory is refused under bun test", async () => {
    usage.__test_forgetEverything();
    process.env.CLAUDE_CONFIG_JSON = "/nonexistent-agx-home/.claude.json";
    try {
      await usage.getUsage(T0);
      expect(usage.__test_loginIdentity()).toBeNull();
    } finally {
      process.env.CLAUDE_CONFIG_JSON = cfg;
    }
  });
});
