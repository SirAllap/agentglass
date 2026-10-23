/*
 * The watch and vote routes, through a real server: what a browser would see. Both are refused from another origin and with writes
 * off, take a boolean and nothing else, and send one request to the site; the card read says the marks and the counts. The token is
 * searched for in every answer.
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const TOKEN = "machine-token-for-the-jira-reads";
let dir = "", base = "", dbFile = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
let fake: FakeJira;
let output = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-jira-follow-routes-"));
  dbFile = join(dir, "r.db");
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  fake = startFakeJira({ pageSize: 2 });
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
let seen = "";
const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  seen += text;
  return { status: r.status, body: JSON.parse(text) as Record<string, any> };
};
const BASE64 = Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString("base64");

const step = story();

describe("the watch and vote routes", () => {
  step("connected, writes off: a 400 with the sentence, and the site never hears of it", async () => {
    expect((await call("POST", "/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).status).toBe(200);
    fake.requests.length = 0;
    for (const p of ["/jira/watch", "/jira/vote"]) {
      const r = await call("POST", p, { key: "ORBIT-1042", on: true });
      expect([p, r.status, r.body]).toEqual([p, 400, { ok: false, error: "Writing to Jira is switched off" }]);
    }
    expect(fake.requests.length).toBe(0);
  });

  step("a page from another origin cannot, even with writes on", async () => {
    expect((await call("POST", "/jira/writes", { on: true })).status).toBe(200);
    fake.requests.length = 0;
    for (const p of ["/jira/watch", "/jira/vote"]) expect((await call("POST", p, { key: "ORBIT-1042", on: true }, { origin: "https://evil.example" })).status).toBe(403);
    expect(fake.requests.length).toBe(0);
  });

  step("on is a boolean: the text false, a missing one and a number are 400s, unsent", async () => {
    for (const on of ["false", undefined, 0, null]) {
      const r = await call("POST", "/jira/watch", { key: "ORBIT-1042", on });
      expect([on, r.status]).toEqual([on, 400]);
    }
    expect(fake.requests.length).toBe(0);
  });

  step("the card read says the marks, then watching and stopping are one request each", async () => {
    const card = await call("GET", "/jira/detail?key=ORBIT-1042");
    expect(card.body.detail.follow).toEqual({ watching: false, watchers: 2, voted: false, votes: 1 });
    fake.requests.length = 0;
    expect(await call("POST", "/jira/watch", { key: "ORBIT-1042", on: true })).toMatchObject({ status: 200, body: { ok: true, on: true } });
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /issue/ORBIT-1042/watchers"]);
    expect(fake.requests[0]!.body).toBe("acc-0001");
    fake.requests.length = 0;
    expect(await call("POST", "/jira/watch", { key: "ORBIT-1042", on: false })).toMatchObject({ status: 200, body: { ok: true, on: false } });
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["DELETE /issue/ORBIT-1042/watchers"]);
    expect(fake.state.issues["ORBIT-1042"]!.watchers).toEqual(["acc-0002", "acc-0003"]);
  });

  step("a vote of your own card is a 400 in our words, and the answer never carries the site's", async () => {
    const r = await call("POST", "/jira/vote", { key: "ORBIT-1000", on: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("voting may be off");
    expect(JSON.stringify(r.body)).not.toContain("you have reported");
  });

  step("the token and the site's credentials are in no answer", () => {
    expect(seen).not.toContain(FAKE_TOKEN);
    expect(seen).not.toContain(BASE64);
    expect(seen).not.toContain(TOKEN);
  });
});
