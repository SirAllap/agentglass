/*
 * The database reader and the spawn broker are on by default: proof on a real
 * server, before the default was flipped and after.
 *
 * Both were opt-in (AGENTGLASS_DBREADER=1, AGENTGLASS_SPAWNBROKER=1) while
 * their own tests (db-reader.test.ts, spawn-broker.test.ts) pinned them at the
 * module level. What this file adds is the whole server: two of them on one
 * database, one started with nothing said (both children on) and one with
 * both set to 0 (every read and every fork done on the main thread, as
 * before). The same question must get the same answer from each, the "on"
 * one must have answered it through its child, and a broker killed under a
 * request must not cost that request its answer.
 *
 * Isolation as AGENTGLASS AGENTS.md asks: HOME, XDG, state, database and the
 * tmux socket directory are all scratch; nothing reaches the live app.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freePort } from "./freePort.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const ENTRY = new URL("../src/index.ts", import.meta.url).pathname;
const DB_TS = new URL("../src/db.ts", import.meta.url).pathname;

type Server = { proc: ReturnType<typeof Bun.spawn>; base: string };
let dir: string, repo: string, slowMark: string, on: Server, off: Server;

const envFor = (name: string, port: number, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
  TMUX_TMPDIR: TMUX_TEST_TMPDIR,
  TMPDIR: tmpdir(),
  HOME: join(dir, name),
  XDG_CONFIG_HOME: join(dir, name, ".config"),
  XDG_DATA_HOME: join(dir, name, ".local/share"),
  XDG_STATE_HOME: join(dir, name, ".local/state"),
  AGENTGLASS_STATE_DIR: join(dir, name, "state"),
  CLAUDE_CONFIG_DIR: join(dir, name, ".claude"),
  AGENTGLASS_ROOT: dir,
  // One database for both: the comparison is of two ways to read the same rows.
  AGENTGLASS_DB: join(dir, "shared.db"),
  AGENTGLASS_SCAN_DISABLED: "1",
  AGENTGLASS_PORT: String(port),
  TZ: "UTC",
  ...extra,
});

async function boot(name: string, extra: Record<string, string>): Promise<Server> {
  mkdirSync(join(dir, name), { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", "run", ENTRY], { env: envFor(name, port, extra), stdout: "ignore", stderr: "pipe" });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return { proc, base }; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error(`${name} did not come up: ` + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}

const health = async (s: Server) => (await fetch(s.base + "/health")).json() as Promise<{
  dbReader: { up: boolean; served: number; fellBack: number } | null;
  spawnBroker: { up: boolean; sent: number } | null;
}>;

/** Waits for a child to say it is up: they start after the port opens. */
async function until(s: Server, ok: (h: Awaited<ReturnType<typeof health>>) => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const h = await health(s);
    if (ok(h)) return h;
    if (Date.now() > end) throw new Error("not up: " + JSON.stringify(h));
    await Bun.sleep(100);
  }
}

/** Every process under `pid`, read from /proc (Linux), with its environment. */
function descendants(pid: number): { pid: number; env: string }[] {
  const out: { pid: number; env: string }[] = [];
  const walk = (p: number) => {
    let tasks: string[] = [];
    try { tasks = readdirSync(`/proc/${p}/task`); } catch { /* the process exited between listing and walking */ }
    for (const t of tasks) {
      let kids: number[] = [];
      try { kids = readFileSync(`/proc/${p}/task/${t}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number); } catch { /* gone */ }
      for (const k of kids) {
        let env = "";
        try { env = readFileSync(`/proc/${k}/environ`, "utf8"); } catch { /* gone */ }
        out.push({ pid: k, env });
        walk(k);
      }
    }
  };
  walk(pid);
  return out;
}

const brokerPidOf = (s: Server) => descendants(s.proc.pid).find((d) => d.env.split("\0").includes("AGENTGLASS_BROKER_CHILD=1"))?.pid ?? null;

const getJson = async (s: Server, path: string) => {
  const r = await fetch(s.base + path);
  expect(r.status, path).toBe(200);
  return r.json() as Promise<Record<string, unknown>>;
};

/** Same, field by field, so a failure names the field. `server_started_at` is each server's own. */
function same(a: Record<string, unknown>, b: Record<string, unknown>, what: string) {
  const strip = (x: Record<string, unknown>) => { const { server_started_at: _, ...rest } = x; return rest; };
  const A = strip(a), B = strip(b);
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) expect(A[k], `${what}: field ${k}`).toEqual(B[k]);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-perfkids-"));
  // Rows to read, in a project under AGENTGLASS_ROOT (a server counts only its own), written through the server's own insert, in a child of its
  // own on the shared file (this process has a test database of its own).
  const seed = `
    const DB = await import(${JSON.stringify(DB_TS)});
    for (let i = 0; i < 24; i++) DB.insertEvent({
      source_app: "orbit", session_id: "kid-s" + (i % 3), hook_event_type: "PostToolUse",
      tool_name: i % 2 ? "Bash" : "Read", tool_use_id: null, agent_id: null, agent_type: null,
      model_name: i % 2 ? "claude-opus-4-8" : "claude-sonnet-4-5", is_error: i % 5 === 0 ? 1 : 0,
      error_text: null, duration_ms: 40 + i,
      usage: { input_tokens: 100 + i, output_tokens: 20 + i, cache_creation_tokens: i, cache_read_tokens: 3 * i },
      usage_is_cumulative: false, summary: "x", timestamp: Date.now() - 120000 - i * 1000,
      payload: { project_path: ${JSON.stringify(join(dir, "repo"))} }, chat: null,
    });`;
  mkdirSync(join(dir, "seed"), { recursive: true });
  const s = Bun.spawnSync(["bun", "-e", seed], { env: envFor("seed", 1), stderr: "pipe" });
  expect(s.exitCode, s.stderr.toString()).toBe(0);
  // A repository for the broker to run git in, with folders so each ask misses the root cache.
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  for (let i = 0; i < 6; i++) mkdirSync(join(repo, `d${i}`, "x"), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", repo], { env: envFor("seed", 1) }).exitCode).toBe(0);
  // A git that waits while a mark file exists, first on the "on" server's PATH:
  // it holds a run inside the broker, so a kill lands with the runs in flight.
  slowMark = join(dir, "slow-git");
  const realGit = Bun.which("git", { PATH: envFor("seed", 1).PATH })!;
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "git"), `#!/bin/sh\n[ -e ${JSON.stringify(slowMark)} ] && sleep 2\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(dir, "bin", "git"), 0o755);
  // Nothing said: what the person gets. A spawn limit above the 5 runs the kill test holds.
  on = await boot("on", { PATH: `${join(dir, "bin")}:${envFor("on", 1).PATH}`, AGENTGLASS_SPAWN_LIMIT: "8" });
  off = await boot("off", { AGENTGLASS_DBREADER: "0", AGENTGLASS_SPAWNBROKER: "0" });
  await until(on, (h) => !!h.dbReader?.up && !!h.spawnBroker?.up);
}, SERVER_BOOT_MS * 2);

afterAll(() => {
  for (const s of [on, off]) try { s?.proc.kill(); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("on by default, off by saying 0", () => {
  test("with nothing set both children are up; with 0 neither starts", async () => {
    const h = await health(on);
    expect(h.dbReader?.up).toBe(true);
    expect(h.spawnBroker?.up).toBe(true);
    const o = await health(off);
    expect(o.dbReader).toBeNull();
    expect(o.spawnBroker).toBeNull();
    expect(brokerPidOf(off)).toBeNull();
  });
});

describe("the database reader", () => {
  test("/stats and /usage/daily answer through it, and match the main thread's answer", async () => {
    const before = (await health(on)).dbReader!;
    for (const path of ["/stats?window=3600000", "/stats?window=all", "/usage/daily?days=7"]) {
      const [a, b] = await Promise.all([getJson(on, path), getJson(off, path)]);
      same(a, b, path);
    }
    // The 24 seeded rows reached the answer: a match of two empty summaries proves nothing.
    expect(JSON.stringify(await getJson(on, "/stats"))).toContain("Bash");
    const after = (await health(on)).dbReader!;
    expect(after.served - before.served).toBeGreaterThanOrEqual(3);
    expect(after.fellBack).toBe(before.fellBack);
  });
});

describe("the spawn broker", () => {
  test("a git read through it answers what a direct spawn answers", async () => {
    const before = (await health(on)).spawnBroker!.sent;
    const ask = (s: Server, sub: string) => getJson(s, `/git/repo?root=${encodeURIComponent(join(repo, sub))}`);
    const [a, b] = await Promise.all([ask(on, "d0"), ask(off, "d0")]);
    expect(a.repo).not.toBeNull();
    expect(a).toEqual(b);
    // Not a repository: the non-zero exit comes back the same way too.
    const [na, nb] = await Promise.all([ask(on, "../seed"), ask(off, "../seed")]);
    expect(na).toEqual({ repo: null });
    expect(nb).toEqual(na);
    expect((await health(on)).spawnBroker!.sent).toBeGreaterThan(before);
  });

  test.skipIf(!existsSync("/proc/self/task"))("a broker killed under a request: the request still gets its answer, and the broker comes back", async () => {
    const pid = brokerPidOf(on);
    expect(pid).not.toBeNull();
    const want = await getJson(off, `/git/repo?root=${encodeURIComponent(join(repo, "d1/x"))}`);
    // All 5 held in the broker by the slow git as it dies: each is lost there
    // and asked again here (a read). `sent` rising by 5 first is the proof
    // that they were in it, and not answered or refused before the kill.
    const sent0 = (await health(on)).spawnBroker!.sent;
    writeFileSync(slowMark, "");
    const asks = [1, 2, 3, 4, 5].map((i) => getJson(on, `/git/repo?root=${encodeURIComponent(join(repo, `d${i}/x`))}`));
    let answered = 0;
    for (const a of asks) void a.then(() => { answered++; }, () => {});
    const held = await until(on, (h) => (h.spawnBroker?.sent ?? 0) >= sent0 + 5, 1500).catch(() => null);
    // Long enough for a git that is not held to answer, short of the slow git's 2 s.
    await Bun.sleep(600);
    const answeredAtKill = answered;
    process.kill(pid!, "SIGKILL");
    rmSync(slowMark, { force: true });
    expect(held, "5 runs handed to the broker before the kill").not.toBeNull();
    expect(answeredAtKill, "none answered before the kill").toBe(0);
    const got = await Promise.all(asks);
    for (const g of got) expect(g).toEqual(want);
    // It is restarted, as a new process.
    await until(on, (h) => !!h.spawnBroker?.up, 15_000);
    const again = brokerPidOf(on);
    expect(again).not.toBeNull();
    expect(again).not.toBe(pid);
  }, 30_000);
});
