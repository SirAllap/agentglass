/*
 * The two Jira move routes, through a real server: what a browser would see.
 * The status codes matter here: a card that changed underneath is a 409 (the
 * page reloads), anything else that was refused is a 400, and a switched-off
 * write never reaches the site. The token is searched for in every answer.
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
  dir = mkdtempSync(join(tmpdir(), "agx-jira-move-routes-"));
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
const updated = (k: string) => Date.parse(fake.state.issues[k]!.updated);

const step = story();

describe("the move routes", () => {
  step("not connected is a sentence and nothing is sent", async () => {
    expect((await call("GET", "/jira/transitions?key=ORBIT-1042")).body).toEqual({ ok: false, error: "Jira is not connected" });
    expect((await call("POST", "/jira/transition", { key: "ORBIT-1042", transitionId: "21", updated: 1 })).body).toEqual({ ok: false, error: "Jira is not connected" });
    expect(fake.requests.length).toBe(0);
  });

  step("connected: the list is a 200 of moves, and an empty one carries its sentence", async () => {
    const c = await call("POST", "/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
    expect(c.status).toBe(200);
    fake.requests.length = 0;
    const r = await call("GET", "/jira/transitions?key=ORBIT-1042");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.options.map((o: { id: string; label: string }) => [o.id, o.label])).toEqual([["21", "In Review"], ["22", "To Do"]]);
    expect(fake.requests.length).toBe(1);
    fake.state.deny.transition.push("ORBIT-1042");
    expect((await call("GET", "/jira/transitions?key=ORBIT-1042")).body).toEqual({ ok: true, options: [], cannot: "You cannot move ORBIT-1042" });
    fake.state.deny.transition.length = 0;
    expect((await call("GET", "/jira/transitions?key=nope")).body).toEqual({ ok: false, error: "That is not a Jira card id" });
  });

  step("writes off: a 400 with the sentence, and the site never hears of it", async () => {
    fake.requests.length = 0;
    const r = await call("POST", "/jira/transition", { key: "ORBIT-1042", transitionId: "21", updated: updated("ORBIT-1042") });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: "Writing to Jira is switched off" });
    expect(fake.requests.length).toBe(0);
  });

  step("a page from another origin cannot move a card, even with writes on", async () => {
    expect((await call("POST", "/jira/writes", { on: true })).status).toBe(200);
    fake.requests.length = 0;
    const r = await call("POST", "/jira/transition", { key: "ORBIT-1042", transitionId: "21", updated: updated("ORBIT-1042") }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(fake.requests.length).toBe(0);
    expect(fake.state.issues["ORBIT-1042"]!.statusId).toBe("2");
  });

  step("a stale stamp is a 409 and the card does not move", async () => {
    const r = await call("POST", "/jira/transition", { key: "ORBIT-1042", transitionId: "21", updated: updated("ORBIT-1042") - 1000 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, conflict: true });
    expect(fake.state.issues["ORBIT-1042"]!.statusId).toBe("2");
  });

  step("a body with no stamp is refused, not sent", async () => {
    fake.requests.length = 0;
    const r = await call("POST", "/jira/transition", { key: "ORBIT-1042", transitionId: "21" });
    expect(r.status).toBe(400);
    expect(fake.requests.length).toBe(0);
  });

  step("the move: a 200 with the card as it is now", async () => {
    const r = await call("POST", "/jira/transition", { key: "ORBIT-1042", transitionId: "21", updated: updated("ORBIT-1042") });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.task).toMatchObject({ customId: "ORBIT-1042", status: "In Review" });
    expect(fake.state.issues["ORBIT-1042"]!.statusId).toBe("3");
  });

  step("a move that needs a field is a 400 and the card stays", async () => {
    const r = await call("POST", "/jira/transition", { key: "ORBIT-1044", transitionId: "41", updated: updated("ORBIT-1044") });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("needs resolution");
    expect(fake.state.issues["ORBIT-1044"]!.statusId).toBe("4");
  });

  step("the token, in neither form, is in any answer or in the server's output", () => {
    for (const s of [FAKE_TOKEN, BASE64]) {
      expect(seen.includes(s)).toBe(false);
      expect(output.includes(s)).toBe(false);
    }
  });
});
