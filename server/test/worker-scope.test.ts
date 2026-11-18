/*
 * A worker's own `wk_` credential is a full-scope machine caller, but it is
 * not every project and it is not the person. Three cases from the
 * adversarial review (.agx-tmp/findings.md), through the real HTTP door with
 * a minted worker token, plus one that a worker's own, legitimate calls still
 * pass.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { callerFor, confinedOwnRoot, revokeWorkerToken } from "../src/auth.ts";
import { holdCredential } from "../src/browseraccess.ts";

const have = !!Bun.which("tmux") && !!Bun.which("git");
const TOKEN = "tok-worker-scope";
const SOCKET = `agx-worker-scope-${process.pid}`;
const json = { "Content-Type": "application/json" };

let dir: string, other: string, base: string, workerOf = "", workerNone = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

const call = async (token: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method, headers: method === "GET" ? { Authorization: `Bearer ${token}` } : { Authorization: `Bearer ${token}`, ...json },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

beforeAll(async () => {
  if (!have) return;
  dir = mkdtempSync(join(tmpdir(), "agx-worker-scope-"));
  other = `${dir}-b`;
  for (const d of [dir, other]) {
    mkdirSync(d, { recursive: true });
    const init = Bun.spawn(["git", "init", "-q", d], { stdout: "ignore", stderr: "ignore" });
    if (await init.exited !== 0) throw new Error("the project did not become a repository");
  }
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  writeFileSync(join(dir, "agentglass", "config.json"), JSON.stringify({ root: [dir, other] }));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  mkdirSync(join(dir, "t"), { recursive: true });
  const workerFile = join(dir, "worker-tokens.json");
  proc = Bun.spawn([process.execPath, "run", new URL("./workerBoot.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      TMPDIR: join(dir, "t"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_DB: join(dir, "s.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TMUX_SOCKET: SOCKET,
      AGENTGLASS_TOKEN: TOKEN,
      WORKER_BOOT_TOKENS: workerFile,
      // `wa` is minted for `dir` (the way a real start's `agentWindowEnv`
      // does); `wb` is minted with no root at all (a start path that never
      // learned one — must speak for no project, never for every one).
      WORKER_BOOT_NAMES: "orbit-scope-wa,orbit-scope-wb",
      WORKER_BOOT_ROOTS: `${dir},`,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  const minted = JSON.parse(readFileSync(workerFile, "utf8")) as { a: string; b: string };
  workerOf = minted.a;
  workerNone = minted.b;
}, SERVER_BOOT_MS);

afterAll(async () => {
  if (!have) return;
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

describe("a held credential's next start is confined too", () => {
  test("holdCredential mints with the root given, not with none", () => {
    const t = holdCredential("agx-held-with-root", "/orbit/acme-v2");
    const caller = callerFor(new Request("http://x/", { headers: { Authorization: `Bearer ${t}` } }), new URL("http://x/"), "unrelated-machine-token");
    expect(caller?.principal).toBe("worker");
    expect(confinedOwnRoot(caller)).toBe("/orbit/acme-v2");
    revokeWorkerToken(t);
  });

  test("holdCredential with no root given still speaks for none, not for every project", () => {
    const t = holdCredential("agx-held-no-root");
    const caller = callerFor(new Request("http://x/", { headers: { Authorization: `Bearer ${t}` } }), new URL("http://x/"), "unrelated-machine-token");
    expect(confinedOwnRoot(caller)).toBeUndefined();
    revokeWorkerToken(t);
  });
});

describe.skipIf(!have)("a worker's credential is not the whole machine", () => {
  test("a worker cannot change another project's settings through the door", async () => {
    // Its own project: narrows, auto-applies.
    const own = await call(workerOf, "POST", "/settings/door", { id: "workers.unixSockets", value: "off", root: dir });
    expect(own.status).toBe(200);
    expect(own.body.ok).toBe(true);
    // Another project, named in the body: the credential proved `dir`, not `other`.
    const foreign = await call(workerOf, "POST", "/settings/door", { id: "workers.unixSockets", value: "all", root: other });
    expect(foreign.status).toBe(403);
    expect(foreign.body.ok).toBe(false);
    expect(foreign.body.error).toContain("own project");
  });

  test("a worker minted with no project speaks for none, not for every one", async () => {
    const r = await call(workerNone, "POST", "/settings/door", { id: "workers.unixSockets", value: "all", root: other });
    expect(r.status).toBe(403);
    expect(r.body.ok).toBe(false);
  });

  test("a worker may not start, stop or prompt another agent", async () => {
    const start = await call(workerOf, "POST", "/agents/named/start", { name: "evil", cwd: other, role: "builder", yolo: true });
    expect(start.status).toBe(403);
    const stop = await call(workerOf, "POST", "/agents/named/stop", { name: "evil" });
    expect(stop.status).toBe(403);
    const prompt = await call(workerOf, "POST", "/agents/named/prompt", { name: "evil", text: "hi" });
    expect(prompt.status).toBe(403);
  });

  test("a worker may not say Go on a flight plan, launched or not", async () => {
    const asApp = { Authorization: `Bearer ${TOKEN}`, ...json, Origin: base };
    const enable = await (await fetch(base + "/settings/door", { method: "POST", headers: asApp, body: JSON.stringify({ id: "flightPlan.enabled", value: true }) })).json() as Record<string, any>;
    expect(enable.ok).toBe(true);
    const plan = await (await fetch(base + "/flight-plan/plans", { method: "POST", headers: asApp, body: JSON.stringify({ root: dir, request: "x" }) })).json() as { plan?: { id: string } };
    expect(plan.plan?.id).toBeTruthy();
    const go = await call(workerOf, "POST", `/flight-plan/plans/${plan.plan!.id}/go`, {});
    expect(go.status).toBe(403);
    const land = await call(workerOf, "POST", `/flight-plan/plans/${plan.plan!.id}/land`, { commit: "0123456789abcdef" });
    expect(land.status).toBe(403);
  });

  test("Land: the person closes a plan with a commit the base holds, and not with one it does not", async () => {
    const asApp = { Authorization: `Bearer ${TOKEN}`, ...json, Origin: base };
    const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: dir }).stdout.toString().trim();
    git("checkout", "-q", "-B", "main");
    git("commit", "-q", "--allow-empty", "-m", "one");
    const inBase = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "side");
    git("commit", "-q", "--allow-empty", "-m", "two");
    const offBase = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    await fetch(base + "/settings/door", { method: "POST", headers: asApp, body: JSON.stringify({ id: "flightPlan.enabled", value: true }) });
    const made = await (await fetch(base + "/flight-plan/plans", { method: "POST", headers: asApp, body: JSON.stringify({ root: dir, request: "x", size: "M" }) })).json() as { plan: { id: string } };
    const bare = (commit: unknown) => fetch(`${base}/flight-plan/plans/${made.plan.id}/land`, { method: "POST", headers: asApp, body: JSON.stringify({ commit }) });
    expect((await bare(inBase)).status).toBe(409); // a draft has no work to land
    await fetch(`${base}/flight-plan/plans/${made.plan.id}`, { method: "PATCH", headers: asApp, body: JSON.stringify({ plan_md: "# Plan\nChange the footer." }) });
    const land = (commit: unknown) => fetch(`${base}/flight-plan/plans/${made.plan.id}/land`, { method: "POST", headers: asApp, body: JSON.stringify({ commit }) });
    expect((await land(offBase)).status).toBe(409);
    expect((await land("--all")).status).toBe(409);
    expect((await land(undefined)).status).toBe(400);
    const ok = await land(inBase.slice(0, 9));
    expect(ok.status).toBe(200);
    const read = await (await fetch(`${base}/flight-plan/plans/${made.plan.id}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as Record<string, any>;
    expect(read.landed).toBe(true);
    expect(read.plan.landedSha).toBe(inBase);
    expect((await land(inBase)).status).toBe(409);
  });

  test("a worker cannot read another project's seat field, tasks or needs", async () => {
    for (const path of ["/seat", "/seat/field", "/seat/tasks", "/seat/needs"]) {
      const foreign = await call(workerOf, "GET", `${path}?format=json&root=${encodeURIComponent(other)}`);
      expect(foreign.status).toBe(403);
      expect(foreign.body.ok).toBe(false);
      // Its own project still reads.
      const own = await call(workerOf, "GET", `${path}?format=json&root=${encodeURIComponent(dir)}`);
      expect(own.status).toBe(200);
    }
  });

  test("a worker's own token has no say over any seat, with or without the agent header", async () => {
    /* The header is the polite way a worker names itself; a worker that leaves
       it off still holds a worker's token, and that is what is refused. */
    for (const verb of ["open", "close", "report", "settings", "wake"]) {
      for (const root of [other, dir]) {
        const r = await call(workerOf, "POST", `/seat/${verb}`, { root });
        expect({ verb, root: root === dir ? "own" : "other", status: r.status, worker: /worker/.test(String(r.body.error)) })
          .toEqual({ verb, root: root === dir ? "own" : "other", status: 403, worker: true });
      }
    }
  });

  test("a worker's own, ordinary calls still pass", async () => {
    const health = await fetch(base + "/health");
    expect(health.ok).toBe(true);
    const read = await call(workerOf, "GET", "/settings/door?id=workers.unixSockets&root=" + encodeURIComponent(dir));
    expect(read.status).toBe(200);
    expect(read.body.ok).toBe(true);
  });
});
