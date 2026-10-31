/*
 * Flight plan under pressure, through a booted isolated server: a mockup that is
 * a symlink out of the project, two presses on the same button at once, a plan
 * edited after Go. The reviewer is preflightStub.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import type { Plan } from "../src/flightPlanStore.ts";

// Launch opens a real tab: on a tmux socket of this file's own, killed when it ends.
const SOCKET = `agx-fplaunch-${process.pid}`;
const TOKEN = "tok-flight-plans-example";
let dir: string, base: string, ROOT: string, shot: string, proc: ReturnType<typeof Bun.spawn> | null = null;
const auth = { Authorization: `Bearer ${TOKEN}` };
const fromApp = () => ({ ...auth, Origin: base, "Content-Type": "application/json" });
const fromAgent = { ...auth, "Content-Type": "application/json" };
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = fromAgent) => {
  const r = await fetch(base + path, { method, headers: method === "GET" ? auth : headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const person = (method: string, path: string, body?: unknown) => call(method, path, body, fromApp());
const makePlan = async (extra: Record<string, unknown> = {}) => (await person("POST", "/flight-plan/plans", { root: ROOT, request: "Cap webhooks per tenant", ...extra })).body.plan as Plan;
const uses = async (id: string) => ((await call("GET", "/usage/opens")).body.opens as { id: string; count: number }[]).find((o) => o.id === id)?.count ?? 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-flightplans-"));
  ROOT = join(dir, "root"); mkdirSync(ROOT);
  // Launch cuts a worktree from the project's main branch, so the project is a repository with one commit.
  for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]]) Bun.spawnSync(["git", ...a], { cwd: ROOT, env: { ...process.env, HOME: dir } });
  shot = join(dir, "screen.png"); writeFileSync(shot, Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(dir, "reply.txt"), "### F1 - Major - Unclear limit\nQuote: q\nEvidence: e");
  // A stand-in `claude` first on PATH: Launch opens a real tmux tab with it, and the tab must not start the real agent.
  mkdirSync(join(dir, "bin")); writeFileSync(join(dir, "bin", "claude"), "#!/bin/sh\ncase \"$1\" in --help|--version) echo \"--name --model --effort\"; exit 0;; esac\nexec sleep 30\n", { mode: 0o755 });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, NODE_ENV: "test",
      AGENTGLASS_PREFLIGHT_BIN: new URL("./preflightStub.ts", import.meta.url).pathname, STUB_REPLY_FILE: join(dir, "reply.txt"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR, AGENTGLASS_TMUX_SOCKET: SOCKET,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: ROOT, AGENTGLASS_DB: join(dir, "d.db"),
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);
afterAll(async () => { proc?.kill(); await Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "kill-server"], { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR }, stdout: "ignore", stderr: "ignore" }).exited; rmSync(dir, { recursive: true, force: true }); });


// Go waits for a finished Preflight when the project reviews plans; these tests are about the presses, so the project reviews nothing.
const open = async () => {
  expect((await person("POST", "/settings/door", { id: "flightPlan.enabled", value: true })).status).toBe(200);
  expect((await person("POST", "/settings/door", { id: "flightPlan.preflight.reviews", value: [], root: ROOT })).status).toBe(200);
};
const ready = async () => {
  const p = await makePlan();
  const r = await person("PATCH", `/flight-plan/plans/${p.id}`, { plan_md: "# Plan\nCap per tenant." });
  expect(r.status).toBe(200);
  return p.id;
};
const runsOf = async (id: string) => ((await call("GET", "/flight-plan/runs")).body.runs as { id: string; state: string }[]).length;

describe("under pressure", () => {
  beforeAll(open);
  test("a mockup that is a symlink to a secret or out of the home folder is refused", async () => {
    const id = await ready();
    writeFileSync(join(dir, ".env"), "KEY=1");
    symlinkSync(join(dir, ".env"), join(ROOT, "shot.png"));
    symlinkSync("/etc/hostname", join(ROOT, "host.png"));
    for (const f of ["shot.png", "host.png"]) {
      const r = await person("PATCH", `/flight-plan/plans/${id}`, { mockups: [join(ROOT, f)] });
      expect(r.status).toBe(400);
    }
  });
  test("two Go presses at once: one wins, one is told no", async () => {
    const id = await ready();
    const s = (await Promise.all([person("POST", `/flight-plan/plans/${id}/go`, {}), person("POST", `/flight-plan/plans/${id}/go`, {})])).map((r) => r.status).sort();
    expect(s).toEqual([200, 409]);
  });
  test("Go launches, and two Launch presses after it start nothing more: one worker", async () => {
    const id = await ready();
    const go = await person("POST", `/flight-plan/plans/${id}/go`, {});
    expect(go.status).toBe(200);
    expect(go.body.plan.state).toBe("launched");
    const rs = await Promise.all([person("POST", `/flight-plan/plans/${id}/launch`, {}), person("POST", `/flight-plan/plans/${id}/launch`, {})]);
    expect(rs.map((r) => r.status)).toEqual([409, 409]);
  });
  test("two Run-review presses at once are one review, not two", async () => {
    // Saving the text of a reviewed project starts a review by itself: take that out of the way so both presses find none open.
    const reviews = (value: string[]) => person("POST", "/settings/door", { id: "flightPlan.preflight.reviews", value, root: ROOT });
    expect((await reviews([])).status).toBe(200);
    const id = await ready();
    expect((await reviews(["plan"])).status).toBe(200);
    const before = await runsOf(id);
    const rs = await Promise.all([person("POST", `/flight-plan/plans/${id}/preflight`, {}), person("POST", `/flight-plan/plans/${id}/preflight`, {})]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(rs[0]!.body.run.id).toBe(rs[1]!.body.run.id);
    expect((await runsOf(id)) - before).toBe(1);
  });
  test("a plan edited after Go goes back to ready and cannot launch", async () => {
    const id = await ready();
    await person("POST", `/flight-plan/plans/${id}/go`, {});
    await person("PATCH", `/flight-plan/plans/${id}`, { plan_md: "# Other plan" });
    const r = await person("POST", `/flight-plan/plans/${id}/launch`, {});
    expect(r.status).toBe(409);
  });
});
