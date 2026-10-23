/*
 * The three Jira routes, through a real server.
 *
 * The server is a separate process with the stand-in site as its Jira base, so
 * what is asserted is what a browser or a phone would see: the answers, the
 * file on disk, the process's own output and the understudy's tables, searched
 * for the token everywhere it could have been copied to.
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const TOKEN = "machine-token-for-the-jira-routes";
let dir = "", base = "", dbFile = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
let fake: FakeJira;
let output = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-jira-routes-"));
  dbFile = join(dir, "r.db");
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  // The understudy on, so a route that is not blind would leave a row.
  writeFileSync(join(dir, "agentglass", "understudy.json"), JSON.stringify({ enabled: true, modes: {} }));
  fake = startFakeJira();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: dbFile,
      AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_JIRA_BASE: fake.base,
    },
    stdout: "pipe", stderr: "pipe",
  });
  // Read both pipes for the whole run, so the output can be searched afterwards.
  for (const s of [proc.stdout, proc.stderr] as ReadableStream[]) {
    void (async () => { for await (const c of s) output += new TextDecoder().decode(c); })();
  }
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  if (!(await fetch(base + "/health").then((r) => r.ok).catch(() => false))) {
    throw new Error("the server did not come up: " + output.slice(0, 400));
  }
}, SERVER_BOOT_MS);

afterAll(async () => {
  try { proc?.kill(); } catch { /* already gone */ }
  await fake?.stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
const GOOD = { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN };
const BASE64 = Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString("base64");
const secretsIn = (text: string) => [FAKE_TOKEN, BASE64].filter((s) => text.includes(s));

const step = story();

describe("the routes", () => {
  step("status before connecting", async () => {
    const r = await fetch(base + "/jira/status", { headers });
    expect(await r.json()).toEqual({ connected: false, site: null, kind: null, auth: null, api: null, deployment: null, account: null, prefixes: [], writes: false, writeKinds: { move: true, comment: true, link: true, assign: true } });
  });

  step("a refused site is a 400 with a sentence, and the stand-in is never asked", async () => {
    const r = await post("/jira/connect", { ...GOOD, site: "notatlassian.net" });
    expect(r.status).toBe(400);
    const j = await r.json() as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(secretsIn(JSON.stringify(j))).toEqual([]);
    expect(fake.requests.length).toBe(0);
  });

  step("a custom site that is not an https hostname is refused the same way", async () => {
    for (const site of ["http://jira.example.com", "https://10.1.2.3", "localhost", "https://169.254.169.254"]) {
      expect((await post("/jira/connect", { ...GOOD, site })).status).toBe(400);
    }
    expect(fake.requests.length).toBe(0);
  });

  step("a refused token is a 400 with the expiry sentence and nothing on disk", async () => {
    const r = await post("/jira/connect", { ...GOOD, token: "wrong-token-for-the-route" });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toContain("expired, been revoked or been blocked");
    expect(() => readFileSync(join(dir, "agentglass", "credentials.json"), "utf8")).toThrow();
  });

  step("a valid connection answers with the name, stores 0600, and echoes nothing", async () => {
    const r = await post("/jira/connect", GOOD);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: true, account: "Ada Example" });
    expect(secretsIn(text)).toEqual([]);
    expect(text).not.toContain(FAKE_EMAIL);
    const file = join(dir, "agentglass", "credentials.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).jira.token).toBe(FAKE_TOKEN);
  });

  step("status after connecting names the site, the account and the keys, and no secret", async () => {
    const r = await fetch(base + "/jira/status", { headers });
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ connected: true, site: "acme.atlassian.net", kind: "cloud", auth: "basic", api: 3, deployment: "cloud", account: "Ada Example", prefixes: ["ORBIT", "ACME"], writes: false, writeKinds: { move: true, comment: true, link: true, assign: true } });
    expect(secretsIn(text)).toEqual([]);
    expect(text).not.toContain(FAKE_EMAIL);
  });

  step("the integrations list shows Jira as connected and carries no secret", async () => {
    const text = await (await fetch(base + "/providers", { headers })).text();
    const row = (JSON.parse(text) as { providers: { id: string; state: string; detail?: string }[] }).providers.find((p) => p.id === "jira")!;
    expect(row).toMatchObject({ state: "connected", detail: "Ada Example · acme.atlassian.net" });
    expect(secretsIn(text)).toEqual([]);
    expect(text).not.toContain(FAKE_EMAIL);
  });

  step("writes are off until asked, and the answer must be a boolean", async () => {
    expect((await post("/jira/writes", { on: "yes" })).status).toBe(400);
    // From an agent (no Origin) it would be a request the person approves: the settings door.
    expect((await post("/jira/writes", { on: true })).status).toBe(202);
    expect(await (await post("/jira/writes", { on: true }, { origin: base })).json()).toEqual({ ok: true, writes: true });
    expect((await (await fetch(base + "/jira/status", { headers })).json() as { writes: boolean }).writes).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "agentglass", "jira-settings.json"), "utf8"))).toEqual({ writes: true });
    expect(await (await post("/jira/writes", { on: false }, { origin: base })).json()).toEqual({ ok: true, writes: false });
  });

  step("a page from another origin cannot connect, change writes or disconnect", async () => {
    const evil = { origin: "https://evil.example" };
    const before = fake.requests.length;
    for (const [path, body] of [["/jira/connect", GOOD], ["/jira/writes", { on: true }], ["/providers/disconnect", { id: "jira" }]] as const) {
      expect((await post(path, body, evil)).status).toBe(403);
    }
    expect(fake.requests.length).toBe(before);
    expect((await (await fetch(base + "/jira/status", { headers })).json() as { writes: boolean; connected: boolean })).toMatchObject({ connected: true, writes: false });
  });

  step("disconnecting through the generic door removes it", async () => {
    const r = await post("/providers/disconnect", { id: "jira" });
    expect(r.status).toBe(200);
    expect((await r.json() as { status: { state: string } }).status.state).toBe("needs-auth");
    expect(readFileSync(join(dir, "agentglass", "credentials.json"), "utf8")).not.toContain(FAKE_TOKEN);
    expect((await (await fetch(base + "/jira/status", { headers })).json() as { connected: boolean }).connected).toBe(false);
  });
});

describe("where else the token could have gone", () => {
  step("the understudy recorded no row for connect, and no column of any table holds the token", () => {
    const db = new Database(dbFile);
    try {
      const rows = db.query("SELECT * FROM understudy_ledger").all() as Record<string, unknown>[];
      expect(rows.filter((r) => String(r.route).startsWith("/jira/connect"))).toEqual([]);
      for (const t of ["understudy_ledger", "understudy_snapshots", "understudy_quarantine", "understudy_precedents"]) {
        for (const row of db.query(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]) {
          for (const [col, v] of Object.entries(row)) expect(secretsIn(String(v ?? "")), `${t}.${col}`).toEqual([]);
        }
      }
      // A write that is NOT blind did leave one: the search above looked at a live table.
      expect(rows.some((r) => r.route === "/jira/writes")).toBe(true);
    } finally { db.close(); }
  });

  step("the server's own output has no token in it", async () => {
    await Bun.sleep(200);
    expect(secretsIn(output)).toEqual([]);
  });
});
