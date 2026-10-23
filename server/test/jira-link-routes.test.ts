/*
 * The two Jira link routes, through a real server: what a browser would see.
 * The read is a 200 with a sentence, the write is refused from another origin,
 * switched off by default, and posts once however often it is asked. The token
 * is searched for in every answer.
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  dir = mkdtempSync(join(tmpdir(), "agx-jira-link-routes-"));
  dbFile = join(dir, "r.db");
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  fake = startFakeJira({ pageSize: 2 });
  // A `gh` that answers the card's search with one pull request and `api user` with a login: the route runs the real search code against it.
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "gh"), `#!/bin/sh
case "$1" in
  api) echo ada ;;
  pr) echo '[{"number":2196,"title":"ORBIT-1042 retry the export","state":"OPEN","isDraft":false,"url":"https://github.com/acme/orbit/pull/2196","body":"","headRefName":"fix/ORBIT-1042-retry","author":{"login":"ada"}}]' ;;
esac
`);
  chmodSync(join(dir, "bin", "gh"), 0o755);
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

const PR = "https://github.com/acme/orbit/pull/2196";
const step = story();

describe("the link routes", () => {
  step("not connected is a sentence and nothing is sent", async () => {
    expect((await call("GET", "/jira/links?key=ORBIT-1042")).body).toEqual({ ok: false, links: [], error: "Jira is not connected" });
    expect((await call("POST", "/jira/link", { key: "ORBIT-1042", url: PR })).body).toEqual({ ok: false, error: "Jira is not connected" });
    expect(fake.requests.length).toBe(0);
  });

  step("connected: the read lists the pull requests on the card, in one request", async () => {
    expect((await call("POST", "/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).status).toBe(200);
    fake.state.remoteLinks["ORBIT-1042"] = [{ id: 1, object: { url: "https://github.com/acme/orbit/pull/2100", title: "#2100" } }, { id: 2, object: { url: "https://wiki.acme.example/x" } }];
    fake.requests.length = 0;
    const r = await call("GET", "/jira/links?key=ORBIT-1042");
    expect(r.status).toBe(200);
    expect(r.body.links.map((l: { number: number }) => l.number)).toEqual([2100]);
    expect(fake.requests.length).toBe(1);
    expect((await call("GET", "/jira/links?key=nope")).body).toMatchObject({ ok: false, error: "That is not a Jira card id" });
  });

  step("writes off: a 400 with the sentence, and the site never hears of it", async () => {
    fake.requests.length = 0;
    const r = await call("POST", "/jira/link", { key: "ORBIT-1042", url: PR });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: "Writing to Jira is switched off" });
    expect(fake.requests.length).toBe(0);
  });

  step("a page from another origin cannot link, even with writes on", async () => {
    expect((await call("POST", "/jira/writes", { on: true })).status).toBe(200);
    fake.requests.length = 0;
    const r = await call("POST", "/jira/link", { key: "ORBIT-1042", url: PR }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(fake.requests.length).toBe(0);
  });

  step("an address that is not a pull request is a 400, unsent", async () => {
    const r = await call("POST", "/jira/link", { key: "ORBIT-1042", url: "javascript:alert(1)" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: "That is not a pull request address" });
    expect(fake.requests.length).toBe(0);
  });

  step("the link: a 200, and the second press is a 200 that wrote nothing", async () => {
    const a = await call("POST", "/jira/link", { key: "ORBIT-1042", url: PR, title: "Retry the export" });
    expect(a).toMatchObject({ status: 200, body: { ok: true, linked: true, url: PR } });
    const b = await call("POST", "/jira/link", { key: "ORBIT-1042", url: PR, title: "Retry the export" });
    expect(b).toMatchObject({ status: 200, body: { ok: true, linked: false } });
    expect(fake.requests.filter((x) => x.method === "POST" && x.path.endsWith("/remotelink")).length).toBe(1);
    expect(fake.state.remoteLinks["ORBIT-1042"]!.some((l) => l.globalId === PR)).toBe(true);
  });

  step("the card's pull requests: the search's row is marked stated, a link it did not find is added", async () => {
    fake.state.remoteLinks["ORBIT-1042"] = [
      { id: 1, object: { url: PR, title: "acme/orbit#2196: Retry the export" } },
      { id: 2, object: { url: "https://github.com/acme/other/pull/5", title: "acme/other#5" } },
    ];
    fake.requests.length = 0;
    const r = await call("GET", "/jira/prs?key=ORBIT-1042");
    expect(r.body.ok).toBe(true);
    expect(r.body.prs.map((p: { number: number; stated?: boolean; link?: string }) => [p.number, !!p.stated, p.link])).toEqual([[2196, true, "own"], [5, true, "own"]]);
    expect(r.body.prs[0].author).toBe("ada");
    expect(fake.requests.filter((x) => x.path.endsWith("/remotelink")).length).toBe(1);
    fake.state.remoteLinks["ORBIT-1042"] = [];
    const bare = await call("GET", "/jira/prs?key=ORBIT-1042");
    expect(bare.body.prs.map((p: { number: number; stated?: boolean }) => [p.number, !!p.stated])).toEqual([[2196, false]]);
  });

  step("the token is in no answer and no log", async () => {
    expect(seen).not.toContain(FAKE_TOKEN);
    expect(seen).not.toContain(BASE64);
    expect(output).not.toContain(FAKE_TOKEN);
    expect(output).not.toContain(BASE64);
  });
});
