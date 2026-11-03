/*
 * SIGNING OFF FROM THE APP'S OWN WINDOW.
 *
 * On a server the desktop app started, `mayAnswerSettingsRequest` asks for the
 * desk key and nothing else: an Origin is a string any holder of the machine
 * token can forge. The Manifest view asked without the key, so its own read
 * answered "off" and its Tested/Failed buttons were disabled in the app the
 * person had just installed.
 *
 * The window's request is the token, the app's Origin and the key on the routes
 * web/src/lib/deskGate.ts lists; a phone with the answer grant may still sign,
 * and every credential an agent holds is refused here as it is everywhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { Database } from "bun:sqlite";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { deskGated } from "../../web/src/lib/deskGate.ts";

const TOKEN = "orbit-manifest-desk-token-0123456789";
const KEY = "desk-key-the-app-minted-for-the-manifest-0123456789";
const APP = "agentglass://app";
const SOCKET = `agx-manifest-desk-${process.pid}`;
const have = !!Bun.which("tmux") && !!Bun.which("git");
const json = { "content-type": "application/json" };

let dir = "", repo = "", build = "", worker = "", phoneRead = "", seat = "";
let proc: ChildProcess | null = null, base = "", said = "";
const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };

const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
const commitFile = (name: string, text: string, subject: string) => {
  writeFileSync(join(repo, name), text);
  git("add", "-A");
  git("commit", "-qm", subject);
  return git("rev-parse", "HEAD").stdout.trim();
};

async function handTab(cwd: string): Promise<string> {
  const p = Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "new-session", "-d", "-P", "-F", "#{pane_id}", "-c", cwd, "sleep", "300"],
    { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR, TMUX: "" }, stdout: "pipe", stderr: "ignore" });
  const pane = (await new Response(p.stdout).text()).trim();
  if (await p.exited !== 0 || !pane) throw new Error("the tab did not open");
  return pane;
}

beforeAll(async () => {
  if (!have) return;
  dir = mkdtempSync(join(tmpdir(), "agx-manifest-desk-"));
  repo = join(dir, "orbit");
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  commitFile("a.txt", "a\n", "ORBIT-1001 the first thing");
  build = commitFile("b.txt", "b\n", "ORBIT-1002 the second thing");
  commitFile("c.txt", "c\n", "ORBIT-1003 the third thing");

  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_DATA_HOME = join(dir, "data");
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  const { issueDevice } = await import("../src/devices.ts");
  phoneRead = issueDevice("Acme phone", "read").token;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const workerFile = join(dir, "worker-tokens.json");
  proc = spawn("bun", ["run", new URL("./workerBoot.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "test", TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir,
      XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, ".claude"), AGENTGLASS_ROOT: repo,
      AGENTGLASS_DB: join(dir, "manifest.db"), AGENTGLASS_TOKEN: TOKEN, AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port), AGENTGLASS_TMUX_SOCKET: SOCKET,
      AGENTGLASS_MANIFEST_BUILD: build,
      AGENTGLASS_DESK_FD: `3:${process.pid}`,
      WORKER_BOOT_TOKENS: workerFile,
      WORKER_BOOT_NAMES: "orbit-manifest-worker",
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  const pipe = proc.stdio[3] as Writable;
  pipe.on("error", () => { /* gone before it read */ });
  pipe.end(`${KEY}\n`);
  proc.stderr?.on("data", (c) => { said = (said + c).slice(-8000); });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  const minted = (await Bun.file(workerFile).json()) as { a: string };
  worker = minted.a;
  // These tests are about who may write, so every seeded commit is after the
  // line; the first read would otherwise put it at HEAD and leave no rows.
  const line = new Database(join(dir, "manifest.db"));
  try { line.query("INSERT OR REPLACE INTO manifest_start (project, sha, at) VALUES (?, ?, 0)").run(repo, "e".repeat(40)); }
  finally { line.close(); }

  const r = await fetch(base + "/seat/adopt", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, origin: base, ...json },
    body: JSON.stringify({ root: repo, session: "s-manifest-desk", pane: await handTab(repo), powers: "assign" }),
  });
  const b = (await r.json()) as Record<string, any>;
  if (b.ok) seat = String(b.token);
}, SERVER_BOOT_MS);

afterAll(async () => {
  if (!have) return;
  if (seat) await fetch(base + "/seat/close", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, origin: base, ...json }, body: JSON.stringify({ root: repo }) }).catch(() => {});
  spawnSync("tmux", ["-L", SOCKET, ...TMUX_ISOLATED, "kill-server"], { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR } });
  proc?.kill();
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** The window's own request, as api.ts sends it on the routes deskGate.ts lists. */
const windowGet = (path: string) => fetch(base + path, {
  headers: { authorization: `Bearer ${TOKEN}`, origin: APP, ...(deskGated(path) ? { "x-agentglass-desk": KEY } : {}) },
});
const windowPost = (body: unknown) => fetch(base + "/manifest/signoff", {
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}`, origin: APP, "content-type": "application/json", ...(deskGated("/manifest/signoff") ? { "x-agentglass-desk": KEY } : {}) },
  body: JSON.stringify(body),
});
/** The window's own press of the start-line button. */
const windowStart = () => fetch(base + "/manifest/start", {
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}`, origin: APP, "content-type": "application/json", ...(deskGated("/manifest/start") ? { "x-agentglass-desk": KEY } : {}) },
  body: JSON.stringify({ project: repo }),
});
const refusedStart = async (headers: Record<string, string>) => {
  const r = await fetch(base + "/manifest/start", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ project: repo }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const lineOf = async (headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, origin: APP, "x-agentglass-desk": KEY }) =>
  ((await (await fetch(`${base}/manifest?project=${encodeURIComponent(repo)}`, { headers })).json()) as Record<string, any>).start?.sha;
const signOffOf = async (headers: Record<string, string>) =>
  ((await (await fetch(`${base}/manifest?project=${encodeURIComponent(repo)}`, { headers })).json()) as Record<string, any>).signOff;
const refused = async (headers: Record<string, string>, body: unknown) => {
  const r = await fetch(base + "/manifest/signoff", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

describe.skipIf(!have)("the Manifest view on a server the app started", () => {
  test("the window's own read may sign, and its verdict is written", async () => {
    expect(deskGated("/manifest")).toBe(true);
    expect(deskGated("/manifest/signoff")).toBe(true);
    const read = await windowGet(`/manifest?project=${encodeURIComponent(repo)}`);
    const b = (await read.json()) as Record<string, any>;
    expect(b.signOff).toBe("yes");
    const post = await windowPost({ project: repo, sha: build, verdict: "tested", note: "the tab strip follows" });
    expect(post.status).toBe(200);
    const after = (await (await windowGet(`/manifest?project=${encodeURIComponent(repo)}`)).json()) as Record<string, any>;
    const row = after.rows.find((x: Record<string, any>) => x.sha === build);
    expect(row.verdict).toBe("tested");
    expect(row.kind).toBe("person");
  });

  test("the same request without the key reads off and cannot sign", async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, origin: APP };
    expect(await signOffOf(headers)).toBe("off");
    const r = await refused(headers, { project: repo, sha: build, verdict: "failed" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("only the person signs off");
  });

  test("the key does not make an agent's request a person's", async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, origin: APP, "x-agentglass-agent": "orbit-manifest-worker", "x-agentglass-desk": KEY };
    expect(await signOffOf(headers)).toBe("off");
    expect((await refused(headers, { project: repo, sha: build, verdict: "failed" })).status).toBe(403);
  });

  test("a worker's own token reads off and cannot sign", async () => {
    const headers = { authorization: `Bearer ${worker}`, origin: APP, "x-agentglass-desk": KEY };
    expect(await signOffOf(headers)).toBe("off");
    expect((await refused(headers, { project: repo, sha: build, verdict: "failed" })).status).toBe(403);
  });

  test("a phone without the grant reads grant and cannot sign", async () => {
    expect(await signOffOf({ authorization: `Bearer ${phoneRead}` })).toBe("grant");
    expect((await refused({ authorization: `Bearer ${phoneRead}` }, { project: repo, sha: build, verdict: "failed" })).status).toBe(403);
  });

  test("the window's own press moves the start line", async () => {
    expect(deskGated("/manifest/start")).toBe(true);
    const r = await windowStart();
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, any>;
    expect(b.start.sha).toBe(git("rev-parse", "HEAD").stdout.trim());
    expect(await lineOf()).toBe(b.start.sha);
  });

  test("the same press without the key is refused", async () => {
    const before = await lineOf();
    const r = await refusedStart({ authorization: `Bearer ${TOKEN}`, origin: APP });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("only the person starts the count from zero");
    expect(await lineOf()).toBe(before);
  });

  test("the key does not make an agent's press a person's", async () => {
    const before = await lineOf();
    const r = await refusedStart({ authorization: `Bearer ${TOKEN}`, origin: APP, "x-agentglass-agent": "orbit-manifest-worker", "x-agentglass-desk": KEY });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("only the person starts the count from zero");
    expect(await lineOf()).toBe(before);
  });

  test("a worker's own token cannot move the line", async () => {
    const before = await lineOf();
    expect((await refusedStart({ authorization: `Bearer ${worker}`, origin: APP, "x-agentglass-desk": KEY })).status).toBe(403);
    expect(await lineOf()).toBe(before);
  });

  test("a phone without the grant cannot move the line", async () => {
    const before = await lineOf();
    expect((await refusedStart({ authorization: `Bearer ${phoneRead}` })).status).toBe(403);
    expect(await lineOf()).toBe(before);
  });
});

describe.skipIf(!have)("a seat's credential", () => {
  test("reads off and cannot sign, even with the app's Origin and the key", async () => {
    expect(seat).not.toBe("");
    const headers = { authorization: `Bearer ${seat}`, origin: APP, "x-agentglass-desk": KEY };
    expect(await signOffOf(headers)).toBe("off");
    expect((await refused(headers, { project: repo, sha: build, verdict: "failed" })).status).toBe(403);
  });

  test("cannot move the start line, even with the app's Origin and the key", async () => {
    const before = await lineOf();
    const r = await refusedStart({ authorization: `Bearer ${seat}`, origin: APP, "x-agentglass-desk": KEY });
    // The seat is refused before the route, with its own sentence, as it is for sign-off.
    expect(r.status).toBe(403);
    expect(await lineOf()).toBe(before);
  });
});
