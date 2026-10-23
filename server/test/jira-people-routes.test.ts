/*
 * The people and hand-off routes, through a real server: what a browser sees.
 * A card that changed underneath is a 409, anything else refused is a 400, a
 * switched-off write never reaches the site, and a write that landed is
 * remembered by the watch as ours, so the bell does not announce it back.
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const TOKEN = "machine-token-for-the-jira-people";
let dir = "", base = "", dbFile = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
let fake: FakeJira;
let output = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-jira-people-routes-"));
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

/** What the watch holds as last seen, by card key: our own writes land here. */
const watched = (): Record<string, { status: string; key: string }> => {
  const p = join(dir, "agentglass", "jira-watch.json");
  if (!existsSync(p)) return {};
  const seen = (JSON.parse(readFileSync(p, "utf8")) as { seen: Record<string, { status: string; key: string }> }).seen;
  return Object.fromEntries(Object.values(seen).map((s) => [s.key, s]));
};

describe("the people and hand-off routes", () => {
  step("not connected: sentences, and nothing is sent", async () => {
    expect((await call("GET", "/jira/assignable?key=ORBIT-1042&q=a")).body).toEqual({ ok: false, error: "Jira is not connected" });
    expect((await call("POST", "/jira/assignee", { key: "ORBIT-1042", to: null, updated: 1 })).body).toEqual({ ok: false, error: "Jira is not connected" });
    expect((await call("POST", "/jira/handoff", { key: "ORBIT-1042", updated: 1, to: "3" })).body).toEqual({ ok: false, error: "Jira is not connected" });
    expect(fake.requests.length).toBe(0);
  });

  step("connected: who can be given the card, as a 200", async () => {
    expect((await call("POST", "/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).status).toBe(200);
    fake.requests.length = 0;
    const r = await call("GET", "/jira/assignable?key=ORBIT-1042&q=gr&transition=21");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, people: [{ key: "acc-0002", id: "acc-0002", name: "Grace Sample", avatar: "https://avatar.acme.example/acc-0002/48.png" }] });
    expect(fake.requests[0]!.query).toMatchObject({ issueKey: "ORBIT-1042", query: "gr", actionDescriptorId: "21" });
  });

  step("writes off: a 400 with the sentence, and the site never hears of it", async () => {
    fake.requests.length = 0;
    const r = await call("POST", "/jira/assignee", { key: "ORBIT-1001", to: "acc-0002", updated: updated("ORBIT-1001") });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: "Writing to Jira is switched off" });
    expect((await call("POST", "/jira/handoff", { key: "ORBIT-1042", updated: updated("ORBIT-1042"), to: "3" })).status).toBe(400);
    expect(fake.requests.length).toBe(0);
  });

  step("a page from another origin can neither write a card nor change the hand-off", async () => {
    expect((await call("POST", "/jira/writes", { on: true })).status).toBe(200);
    fake.requests.length = 0;
    const evil = { origin: "https://evil.example" };
    expect((await call("POST", "/jira/assignee", { key: "ORBIT-1001", to: "acc-0002", updated: updated("ORBIT-1001") }, evil)).status).toBe(403);
    expect((await call("POST", "/jira/handoff", { key: "ORBIT-1042", updated: updated("ORBIT-1042"), to: "3" }, evil)).status).toBe(403);
    expect((await call("POST", "/jira/settings", { project: "ORBIT", rule: null }, evil)).status).toBe(403);
    expect(fake.requests.length).toBe(0);
  });

  step("a body that is not a person or nobody is refused, not sent", async () => {
    const r = await call("POST", "/jira/assignee", { key: "ORBIT-1001", to: 7, updated: updated("ORBIT-1001") });
    expect(r.status).toBe(400);
    expect(fake.requests.length).toBe(0);
  });

  step("assign: a 200 with the card, and the watch remembers the change as ours", async () => {
    const r = await call("POST", "/jira/assignee", { key: "ORBIT-1001", to: "acc-0002", updated: updated("ORBIT-1001") });
    expect(r.status).toBe(200);
    expect(r.body.task).toMatchObject({ customId: "ORBIT-1001", assignees: ["Grace Sample"] });
    // Given to somebody else: not kept as seen, so the card coming back to me is news.
    expect(watched()["ORBIT-1001"]).toBeUndefined();
    const mine = await call("POST", "/jira/assignee", { key: "ORBIT-1001", to: "acc-0001", updated: updated("ORBIT-1001") });
    expect(mine.body.task).toMatchObject({ mine: true });
    expect(watched()["ORBIT-1001"]).toMatchObject({ status: "To Do" });
  });

  step("a stale stamp is a 409 and nothing changes", async () => {
    const r = await call("POST", "/jira/handoff", { key: "ORBIT-1042", updated: updated("ORBIT-1042") - 1000, to: "3", clear: true });
    expect(r.status).toBe(409);
    expect(fake.state.issues["ORBIT-1042"]!.statusId).toBe("2");
  });

  step("the settings: read, a rule saved, the statuses to choose from", async () => {
    expect((await call("GET", "/jira/settings")).body).toEqual({ ok: true, writes: true, handoff: {} });
    const rule = { to: { id: "3", name: "In Review" }, askTo: false, clear: true, askClear: true };
    const s = await call("POST", "/jira/settings", { project: "ORBIT", rule });
    expect(s.body).toEqual({ ok: true, writes: true, handoff: { ORBIT: rule } });
    expect((await call("POST", "/jira/settings", { project: "ORBIT" })).status).toBe(400);
    const st = await call("GET", "/jira/project-statuses?project=ORBIT");
    expect(st.body.statuses.map((x: { name: string }) => x.name)).toEqual(["To Do", "In Progress", "In Review", "QA", "Done"]);
  });

  step("the hand-off by the setting: moved, nobody on it, and remembered as our move", async () => {
    const r = await call("POST", "/jira/handoff", { key: "ORBIT-1042", updated: updated("ORBIT-1042") });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, was: "In Progress", task: { status: "In Review", assignees: [] } });
    expect(watched()["ORBIT-1042"]).toMatchObject({ status: "In Review" });
  });

  step("a hand-off that landed short is a 200 with the warning in `partial`", async () => {
    fake.fail({ path: "/issue/ORBIT-1000/assignee", method: "PUT", status: 403 });
    const r = await call("POST", "/jira/handoff", { key: "ORBIT-1000", updated: updated("ORBIT-1000"), to: "1", clear: true });
    expect(r.status).toBe(200);
    expect(r.body.partial).toBe("Moved to To Do, but Ada Example is still assigned: Your Jira account cannot assign this card");
    expect(watched()["ORBIT-1000"]).toMatchObject({ status: "To Do" });
  });

  step("the token, in neither form, is in any answer or in the server's output", () => {
    for (const s of [FAKE_TOKEN, BASE64]) {
      expect(seen.includes(s)).toBe(false);
      expect(output.includes(s)).toBe(false);
    }
  });
});
