/*
 * The step routes, through a real server: what a browser sees. A stamp that
 * moved is a 409 and no write, anything else refused is a 400, a switched-off
 * write never reaches the site, a page from another origin can neither run a
 * step nor change one, and a move that landed is remembered by the watch as
 * ours so the bell does not announce it back.
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

const TOKEN = "machine-token-for-the-jira-steps";
let dir = "", base = "", dbFile = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
let fake: FakeJira;
let output = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-jira-step-routes-"));
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
const PR = { url: "https://github.com/acme/orbit/pull/318", title: "Retry the export", number: 318, author: "octo-ada" };
const watched = (): Record<string, { status: string; key: string }> => {
  const p = join(dir, "agentglass", "jira-watch.json");
  if (!existsSync(p)) return {};
  const seen = (JSON.parse(readFileSync(p, "utf8")) as { seen: Record<string, { status: string; key: string }> }).seen;
  return Object.fromEntries(Object.values(seen).map((s) => [s.key, s]));
};

describe("the step routes", () => {
  step("not connected: a sentence, and nothing is sent", async () => {
    const r = await call("POST", "/jira/step", { key: "ORBIT-1042", updated: 1, trigger: "handoff" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: "Jira is not connected" });
    expect(fake.requests.length).toBe(0);
  });

  step("the steps read as defaults, then save, then read back", async () => {
    expect((await call("GET", "/jira/steps")).body).toEqual({ ok: true, overrides: [], steps: { handoff: { enabled: false, blocks: [] }, review: { enabled: false, blocks: [] }, merge: { enabled: false, blocks: [] } } });
    const blocks = [{ type: "move", statusNames: ["In Review"] }, { type: "comment", text: "Opened {pr}" }, { type: "link" }];
    const saved = await call("POST", "/jira/steps", { steps: { handoff: { enabled: true, blocks } } });
    expect(saved.status).toBe(200);
    expect(saved.body.steps.handoff).toEqual({ enabled: true, blocks });
    expect((await call("GET", "/jira/steps")).body.steps.handoff.blocks).toEqual(blocks);
    // GET /jira/settings is the switch and the older rules, as it was.
    expect((await call("GET", "/jira/settings")).body).toEqual({ ok: true, writes: false, handoff: {} });
  });

  step("a refused save is a 400 with a sentence, and the saved step is unchanged", async () => {
    const r = await call("POST", "/jira/steps", { steps: { handoff: { blocks: [{ type: "field", field: "Team", value: "Blue" }] } } });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect((await call("GET", "/jira/steps")).body.steps.handoff.blocks.length).toBe(3);
  });

  step("writes off: a 400 with the sentence, and the site never hears of it", async () => {
    expect((await call("POST", "/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).status).toBe(200);
    fake.requests.length = 0;
    const r = await call("POST", "/jira/step", { key: "ORBIT-1042", updated: updated("ORBIT-1042"), trigger: "handoff", pr: PR });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: "Writing to Jira is switched off" });
    expect(fake.requests.length).toBe(0);
  });

  step("a page from another origin can neither run a step nor change one", async () => {
    expect((await call("POST", "/jira/writes", { on: true }, { origin: base })).status).toBe(200);
    fake.requests.length = 0;
    const evil = { origin: "https://evil.example" };
    expect((await call("POST", "/jira/step", { key: "ORBIT-1042", updated: updated("ORBIT-1042"), trigger: "handoff", pr: PR }, evil)).status).toBe(403);
    expect((await call("POST", "/jira/steps", { steps: { merge: { enabled: true } } }, evil)).status).toBe(403);
    expect(fake.requests.length).toBe(0);
  });

  step("a stamp that moved is a 409 and no write", async () => {
    fake.requests.length = 0;
    const r = await call("POST", "/jira/step", { key: "ORBIT-1042", updated: updated("ORBIT-1042") - 1000, trigger: "handoff", pr: PR });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, conflict: true });
    expect(fake.requests.filter((q) => q.method !== "GET").length).toBe(0);
  });

  step("a step that lands: the move, the comment and the link, as one request, and the watch holds the move as ours", async () => {
    fake.requests.length = 0;
    const r = await call("POST", "/jira/step", { key: "ORBIT-1042", updated: updated("ORBIT-1042"), trigger: "handoff", pr: PR });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, was: "In Progress", task: { status: "In Review" } });
    expect(r.body.partial).toBeUndefined();
    expect(fake.requests.filter((q) => q.method !== "GET").map((q) => q.path)).toEqual(["/issue/ORBIT-1042/transitions", "/issue/ORBIT-1042/comment", "/issue/ORBIT-1042/remotelink"]);
    expect(watched()["ORBIT-1042"]?.status).toBe("In Review");
  });

  step("a merge step told to leave the card where it is still posts its comment and moves nothing", async () => {
    expect((await call("POST", "/jira/steps", { steps: { merge: { enabled: true, blocks: [{ type: "move", statusNames: ["Done"] }, { type: "comment", text: "Merged {pr_url}" }] } } })).status).toBe(200);
    const was = fake.state.issues["ORBIT-1043"]!.statusId;
    fake.requests.length = 0;
    const r = await call("POST", "/jira/step", { key: "ORBIT-1043", updated: updated("ORBIT-1043"), trigger: "merge", choice: { stay: true }, pr: PR });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(fake.requests.filter((q) => q.method !== "GET").map((q) => q.path)).toEqual(["/issue/ORBIT-1043/comment"]);
    expect(fake.state.issues["ORBIT-1043"]!.statusId).toBe(was);
  });

  step("a pull request address that is not one on a known host is refused before any request, though only the comment would quote it", async () => {
    fake.requests.length = 0;
    for (const url of ["https://evil.example/acme/orbit/pull/1", "javascript:alert(1)", "http://github.com/acme/orbit/pull/1", "https://github.com@evil.example/acme/orbit/pull/1"]) {
      const r = await call("POST", "/jira/step", { key: "ORBIT-1043", updated: updated("ORBIT-1043"), trigger: "merge", choice: { stay: true }, pr: { ...PR, url } });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ ok: false, error: "That is not a pull request address" });
    }
    expect(fake.requests.length).toBe(0);
  });

  step("the comment names the pull request by the number in its address, whatever number came with it", async () => {
    fake.requests.length = 0;
    expect((await call("POST", "/jira/steps", { steps: { merge: { enabled: true, blocks: [{ type: "comment", text: "Merged {pr}" }] } } })).status).toBe(200);
    const r = await call("POST", "/jira/step", { key: "ORBIT-1043", updated: updated("ORBIT-1043"), trigger: "merge", pr: { ...PR, number: 999 } });
    expect(r.body.ok).toBe(true);
    const said = JSON.stringify(fake.requests.find((q) => q.method === "POST" && q.path === "/issue/ORBIT-1043/comment")?.body);
    expect(said).toContain("#318 Retry the export");
    expect(said).not.toContain("999");
  });

  step("status units: the projects holding the person's cards, with the site's own statuses, and the pick is kept", async () => {
    const r = await call("GET", "/jira/status-units");
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("tasks");
    const unit = (r.body.spaces as { id: string; statuses: { status: string }[]; counted?: boolean }[]).find((u) => u.id === "ORBIT")!;
    expect(unit.counted).toBeUndefined();
    expect(unit.statuses.map((x) => x.status)).toEqual(["To Do", "In Progress", "In Review", "QA", "Done"]);
    expect(r.body.counted).toEqual([]);
    expect((await call("POST", "/jira/status-units", { counted: ["ORBIT"] })).body).toEqual({ ok: true, counted: ["ORBIT"] });
    expect((await call("GET", "/jira/status-units")).body).toMatchObject({ source: "chosen", counted: ["ORBIT"] });
    expect((await call("POST", "/jira/status-units", { counted: ["not a key"] })).status).toBe(400);
    expect((await call("POST", "/jira/status-units", { counted: ["ORBIT"] }, { origin: "https://evil.example" })).status).toBe(403);
  });

  step("the pick of projects is a closed shape: no extra keys, no empty body, no key longer than a key can be", async () => {
    expect((await call("POST", "/jira/status-units", { counted: ["ORBIT"], extra: 1 })).status).toBe(400);
    const r = await fetch(base + "/jira/status-units", { method: "POST", headers, body: "null" });
    expect(r.status).toBe(400);
    expect((await call("POST", "/jira/status-units", { counted: ["A".repeat(40)] })).status).toBe(400);
    expect((await call("GET", "/jira/status-units")).body.counted).toEqual(["ORBIT"]);
  });

  step("the answer never carries the token", async () => {
    expect(seen).not.toContain(FAKE_TOKEN);
    expect(seen).not.toContain(BASE64);
  });
});
