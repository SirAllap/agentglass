/*
 * The board context and rank routes, through a real server: what a browser
 * would see. The context is a read with its sentence, a narrowed board read
 * takes ids and never a query, and the rank is refused from another origin,
 * switched off by default and one request when it goes.
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
  dir = mkdtempSync(join(tmpdir(), "agx-jira-board-routes-"));
  dbFile = join(dir, "r.db");
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  fake = startFakeJira({ pageSize: 2 });
  mkdirSync(join(dir, "bin"), { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
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

describe("the board routes", () => {
  step("not connected is a sentence and nothing is sent", async () => {
    expect((await call("GET", "/jira/board-context?id=board:3")).body).toMatchObject({ ok: false, error: "Jira is not connected", filters: [], epics: [] });
    expect((await call("POST", "/jira/rank", { key: "ORBIT-1043", before: "ORBIT-1042" })).body).toEqual({ ok: false, error: "Jira is not connected" });
    expect(fake.requests.length).toBe(0);
  });

  step("connected: the context is three reads, and a second ask is none", async () => {
    expect((await call("POST", "/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).status).toBe(200);
    expect((await call("POST", "/jira/views/add", { kind: "board", id: "3" })).status).toBe(200);
    fake.requests.length = 0;
    const r = await call("GET", "/jira/board-context?id=board:3");
    expect(r.status).toBe(200);
    expect(r.body.filters.map((q: { name: string }) => q.name)).toEqual(["Only bugs", "High priority"]);
    expect(r.body.sprint).toMatchObject({ name: "Sprint 4" });
    expect(JSON.stringify(r.body)).not.toContain("issuetype = Bug");
    expect(fake.requests.length).toBe(3);
    await call("GET", "/jira/board-context?id=board:3");
    expect(fake.requests.length).toBe(3);
  });

  step("a board read takes filter ids, and an id it does not have is a sentence", async () => {
    const all = await call("GET", "/jira/view?id=board:3&force=1");
    const bugs = await call("GET", "/jira/view?id=board:3&filters=1");
    expect(bugs.body.ok).toBe(true);
    expect(bugs.body.tasks.length).toBeLessThan(all.body.tasks.length);
    // A query smuggled in as an id is no id.
    fake.requests.length = 0;
    const evil = await call("GET", "/jira/view?id=board:3&filters=" + encodeURIComponent("1) OR (project = X"));
    expect(evil.body.ok).toBe(false);
    expect(fake.requests.filter((x) => x.path.startsWith("/search")).length).toBe(0);
  });

  step("rank: off by default, from another origin refused, then one request", async () => {
    fake.requests.length = 0;
    const off = await call("POST", "/jira/rank", { key: "ORBIT-1043", before: "ORBIT-1042" });
    expect(off).toMatchObject({ status: 400, body: { ok: false, error: "Writing to Jira is switched off" } });
    expect(fake.requests.length).toBe(0);
    expect((await call("POST", "/jira/writes", { on: true })).status).toBe(200);
    const evil = await call("POST", "/jira/rank", { key: "ORBIT-1043", before: "ORBIT-1042" }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(fake.requests.length).toBe(0);
    const bad = await call("POST", "/jira/rank", { key: "ORBIT-1043" });
    expect(bad.status).toBe(400);
    expect(fake.requests.length).toBe(0);
    const ok = await call("POST", "/jira/rank", { key: "ORBIT-1043", before: "ORBIT-1042" });
    expect(ok).toMatchObject({ status: 200, body: { ok: true } });
    expect(fake.requests.length).toBe(1);
    expect(fake.requests[0]).toMatchObject({ method: "PUT", path: "/rest/agile/1.0/issue/rank" });
  });

  step("the token is in no answer and no log", async () => {
    expect(seen).not.toContain(FAKE_TOKEN);
    expect(seen).not.toContain(BASE64);
    expect(output).not.toContain(FAKE_TOKEN);
    expect(output).not.toContain(BASE64);
  });
});
