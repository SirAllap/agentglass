/*
 * The comment routes through a real server: what a browser would see. Reads
 * answer 200 with a sentence when refused; the comment is a write behind the
 * switch and the same-origin check, 400 with a sentence when refused. The
 * token is searched for in every answer and in the server's output.
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

const TOKEN = "machine-token-for-the-jira-comments";
let dir = "", base = "", dbFile = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
let fake: FakeJira;
let output = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-jira-comment-routes-"));
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

describe("the comment routes", () => {
  step("not connected is a sentence and nothing is sent", async () => {
    expect((await call("GET", "/jira/detail?key=ORBIT-1042")).body).toEqual({ ok: false, error: "Jira is not connected" });
    expect((await call("GET", "/jira/people?key=ORBIT-1042&q=a")).body).toEqual({ ok: false, error: "Jira is not connected" });
    const w = await call("POST", "/jira/comment", { key: "ORBIT-1042", text: "hi" });
    expect(w.status).toBe(400);
    expect(w.body).toEqual({ ok: false, error: "Jira is not connected" });
    expect(fake.requests.length).toBe(0);
  });

  step("connected: the card with its words is a 200", async () => {
    expect((await call("POST", "/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).status).toBe(200);
    const r = await call("GET", "/jira/detail?key=ORBIT-1042");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.more).toBe(0);
    expect(r.body.detail.task.customId).toBe("ORBIT-1042");
    expect(r.body.detail.comments.map((c: { text: string }) => c.text)).toEqual(["@Ada Example can you take a look at the retry loop?"]);
    expect((await call("GET", "/jira/detail?key=nope")).body).toEqual({ ok: false, error: "That is not a Jira card id" });
  });

  step("who can be mentioned is a 200 list", async () => {
    const r = await call("GET", "/jira/people?key=ORBIT-1042&q=ada");
    expect(r.status).toBe(200);
    expect(r.body.people).toEqual([expect.objectContaining({ key: "acc-0001", name: "Ada Example" })]);
  });

  step("writes off: a 400 with the sentence, and the site never hears of it", async () => {
    fake.requests.length = 0;
    const r = await call("POST", "/jira/comment", { key: "ORBIT-1042", text: "hi" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: "Writing to Jira is switched off" });
    expect(fake.requests.length).toBe(0);
  });

  step("a page from another origin cannot comment, even with writes on", async () => {
    expect((await call("POST", "/jira/writes", { on: true }, { origin: base })).status).toBe(200);
    fake.requests.length = 0;
    const r = await call("POST", "/jira/comment", { key: "ORBIT-1042", text: "hi" }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(fake.requests.length).toBe(0);
    expect(fake.state.issues["ORBIT-1042"]!.comments.length).toBe(1);
  });

  step("the comment: a 200 with the card and its thread as they are now, in two requests", async () => {
    fake.requests.length = 0;
    const r = await call("POST", "/jira/comment", { key: "ORBIT-1042", text: "**done**, @Ada Example", mentions: [{ id: "acc-0001", name: "Ada Example" }] });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.task.updated).toBe(Date.parse(fake.state.issues["ORBIT-1042"]!.updated));
    expect(r.body.detail.comments.at(-1).text).toBe("**done**, @Ada Example");
    expect(fake.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["POST /issue/ORBIT-1042/comment", "GET /issue/ORBIT-1042"]);
    expect(JSON.stringify(fake.requests[0]!.body)).toContain(`{"type":"mention","attrs":{"id":"acc-0001","text":"@Ada Example"}}`);
  });

  step("an empty comment is a 400 and nothing is sent", async () => {
    fake.requests.length = 0;
    const r = await call("POST", "/jira/comment", { key: "ORBIT-1042", text: "   " });
    expect(r.status).toBe(400);
    expect(fake.requests.length).toBe(0);
  });

  step("the token, in neither form, is in any answer or in the server's output", () => {
    for (const s of [FAKE_TOKEN, BASE64]) {
      expect(seen.includes(s)).toBe(false);
      expect(output.includes(s)).toBe(false);
    }
  });
});
