/*
 * The four Jira read routes, through a real server.
 *
 * The server is a separate process whose Jira base is the stand-in behind a
 * pass-through (the stand-in cannot read `text ~`), so what is asserted is what
 * a browser or a phone would see: the answers, the status code, the request
 * count at the site, and the token searched for in every answer and in the
 * process's own output.
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";
import { startJiraProxy, type JiraProxy } from "./fixtures/jiraTextProxy.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const TOKEN = "machine-token-for-the-jira-reads";
let dir = "", base = "", dbFile = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
let fake: FakeJira;
let proxy: JiraProxy;
let output = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-jira-read-routes-"));
  dbFile = join(dir, "r.db");
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  fake = startFakeJira({ pageSize: 2 });
  proxy = startJiraProxy(fake.base);
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
      AGENTGLASS_JIRA_BASE: proxy.base,
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
  await proxy?.stop();
  await fake?.stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const get = async (path: string) => {
  const r = await fetch(base + path, { headers });
  const text = await r.text();
  seen += text;
  return { status: r.status, body: JSON.parse(text) as Record<string, any> };
};
let seen = "";
const BASE64 = Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString("base64");

const step = story();

describe("the read routes", () => {
  step("not connected is an answer, not a failed request, and nothing is sent", async () => {
    for (const p of ["/jira/task?id=ORBIT-1042", "/jira/find?q=ORBIT-1042", "/jira/mine", "/jira/search?q=sync"]) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: false, error: "Jira is not connected" });
    }
    expect(fake.requests.length).toBe(0);
  });

  step("connect, then one card, a find, the list and a search", async () => {
    const c = await fetch(base + "/jira/connect", { method: "POST", headers, body: JSON.stringify({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN }) });
    expect(c.status).toBe(200);
    fake.requests.length = 0;

    const one = await get("/jira/task?id=ORBIT-1042");
    expect(one.status).toBe(200);
    expect(one.body.ok).toBe(true);
    expect(one.body.task).toMatchObject({ customId: "ORBIT-1042", statusKind: "open", mine: true, priority: "high", url: "https://acme.atlassian.net/browse/ORBIT-1042" });
    expect(fake.requests.filter((q) => q.path.startsWith("/issue/")).length).toBe(1);

    const found = await get("/jira/find?q=1042");
    expect(found.body).toMatchObject({ ok: true, asked: "ORBIT-1042", task: { customId: "ORBIT-1042" } });

    const mine = await get("/jira/mine");
    expect(mine.body.ok).toBe(true);
    expect(mine.body.tasks.map((t: { customId: string }) => t.customId).sort()).toEqual(["ORBIT-1000", "ORBIT-1042", "ORBIT-1050"]);
    expect(mine.body.truncated).toBe(false);

    const found2 = await get("/jira/search?q=sync%20board");
    expect(found2.body.ok).toBe(true);
    expect(found2.body.tasks.length).toBeGreaterThan(0);
    expect(proxy.jql.at(-1)).toBe('project in ("ORBIT", "ACME") AND text ~ "sync board" ORDER BY updated DESC');
  });

  step("the list is kept for a minute, and Refresh (fresh=1) asks again", async () => {
    const searches = () => fake.requests.filter((q) => q.path === "/search/jql").length;
    const before = searches();
    const again = await get("/jira/mine");
    expect(again.body.ok).toBe(true);
    expect(searches()).toBe(before);
    const forced = await get("/jira/mine?fresh=1");
    expect(forced.body.ok).toBe(true);
    expect(searches()).toBeGreaterThan(before);
  });

  step("a bad id, a missing card and an empty search are sentences with a 200", async () => {
    expect((await get("/jira/task?id=ORBIT-1042/transitions")).body).toEqual({ ok: false, error: "That is not a Jira card id" });
    expect((await get("/jira/task?id=ORBIT-9999")).body).toEqual({ ok: false, error: "ORBIT-9999 was not found or you cannot see it" });
    expect((await get("/jira/search?q=")).body).toEqual({ ok: false, error: "Type something to search for" });
    expect((await get("/jira/find?q=fix%20it")).body.ok).toBe(false);
  });

  step("a rate limit is reported as throttled", async () => {
    fake.fail({ path: "/search/jql", status: 429, retryAfter: 30, reason: "jira-burst-based", times: 1 });
    const r = await get("/jira/mine?fresh=1");
    expect(r.body).toMatchObject({ ok: false, throttled: true });
    expect(r.body.error).toContain("try again in 30s");
  });

  step("the token, in neither form, is in any answer or in the server's output", () => {
    for (const s of [FAKE_TOKEN, BASE64]) {
      expect(seen.includes(s)).toBe(false);
      expect(output.includes(s)).toBe(false);
    }
  });
});
