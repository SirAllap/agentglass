/*
 * A locked OpenCode 2.x worker runs against a private `serve` that was asked for its
 * resolved rules first (agents/opencodeserve.ts). Nothing here may ever vouch for a
 * lock it could not read, and no server may outlive a refusal.
 *
 * The OpenCode is a bun script on disk that answers like 2.1.4 measured: Basic auth
 * with the password from OPENCODE_SERVER_PASSWORD, /api/info with its pid, agents
 * listed only after /api/location, `bash` shown as `shell`. FAKE_MODE bends the answer.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardTurn, serveRules, startLockedServe, stopServe } from "../src/agents/opencodeserve.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-oc-serve-test-"));
const started: number[] = [];
afterAll(() => {
  for (const pid of started) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

const FAKE = `#!/usr/bin/env bun
const a = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "holds";
if (a[0] === "--version") { console.log("opencode v" + (process.env.FAKE_VERSION ?? "2.1.4")); process.exit(0); }
if (a[0] !== "serve") process.exit(1);
if (mode === "nobody") { setInterval(() => {}, 1000); } else {
  const lock = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
  const rules = [{ action: "*", resource: "*", effect: "allow" }]; // as the real one starts: everything allowed, the lock after it
  for (const [k, v] of Object.entries(lock.permission ?? {})) {
    const action = k === "bash" ? "shell" : k === "task" ? "subagent" : k;
    if (typeof v === "string") rules.push({ action, resource: "*", effect: v });
    else for (const [p, e] of Object.entries(v)) rules.push({ action, resource: p, effect: e });
  }
  if (mode === "loosened") rules.push({ action: "shell", resource: "*", effect: "allow" });
  const want = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
  let loadedAt = 0;
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (req.headers.get("authorization") !== want) return Response.json({ _tag: "UnauthorizedError" }, { status: 401 });
    const p = new URL(req.url).pathname;
    if (p === "/api/info") return Response.json({ version: "2.1.4", pid: process.pid });
    if (p === "/api/location") { loadedAt = Date.now(); return Response.json({ directory: process.cwd() }); }
    if (p === "/api/agent") {
      if (mode === "garbage") return new Response("<html>not json</html>");
      const permissions = mode === "norules" ? rules.filter((r) => r.action !== "shell") : rules;
      return Response.json({ data: loadedAt && Date.now() - loadedAt > 600 ? [{ id: "build", permissions }] : [] });
    }
    return new Response("no", { status: 404 });
  } });
  console.log("server listening on http://127.0.0.1:" + s.port);
}
`;
const bin = join(dir, "opencode");
writeFileSync(bin, FAKE);
chmodSync(bin, 0o755);

const lock = JSON.stringify({ default_agent: "build", permission: { bash: { "git push *": "deny", "echo *": "deny" }, task: "deny" } });
const env = (mode: string, version = "2.1.4") => ({ OPENCODE_CONFIG_CONTENT: lock, FAKE_MODE: mode, FAKE_VERSION: version });
const gone = async (pids: number[]) => {
  for (let i = 0; i < 50; i++) { if (pids.every((p) => !existsSync(`/proc/${p}`))) return true; await Bun.sleep(100); }
  return false;
};

describe("what the serve says about its agent is read strictly", () => {
  const ok = { data: [{ id: "build", permissions: [{ action: "shell", resource: "echo *", effect: "deny" }, { action: "webfetch", resource: "*", effect: "deny" }] }] };
  test("subagent becomes task, so a later allow-all does not read as loosening a task deny", () => {
    const body = { data: [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "subagent", resource: "*", effect: "deny" }, { action: "shell", resource: "x", effect: "deny" }] }] };
    expect(serveRules(body, "build")?.[1]).toEqual({ permission: "task", pattern: "*", action: "deny" });
  });
  test("shell becomes bash, the other names stay", () => {
    expect(serveRules(ok, "build")).toEqual([
      { permission: "bash", pattern: "echo *", action: "deny" }, { permission: "webfetch", pattern: "*", action: "deny" },
    ]);
  });
  test.each([
    ["not an object", "html"], ["no data", {}], ["no such agent", { data: [] }],
    ["no permissions", { data: [{ id: "build" }] }], ["empty permissions", { data: [{ id: "build", permissions: [] }] }],
    ["a rule of another shape", { data: [{ id: "build", permissions: [{ action: "shell", resource: "x" }] }] }],
    ["no shell rule at all", { data: [{ id: "build", permissions: [{ action: "webfetch", resource: "*", effect: "deny" }] }] }],
  ])("%s: null, so the worker is refused", (_n, body) => {
    expect(serveRules(body, "build")).toBeNull();
  });
});

describe.skipIf(process.platform !== "linux")("the private server vouches for the lock or goes", () => {
  test("a lock that holds: the server is up on loopback with its own random password, and stops by its recorded pids", async () => {
    const a = await startLockedServe(bin, dir, env("holds"));
    const b = await startLockedServe(bin, dir, env("holds"));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    started.push(...a.serve.pids, ...b.serve.pids);
    expect(a.serve.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(a.serve.password.length).toBeGreaterThanOrEqual(32);
    expect(a.serve.password).not.toBe(b.serve.password);
    expect(a.serve.url).not.toBe(b.serve.url);
    expect(a.serve.pids.every((p) => existsSync(`/proc/${p}`))).toBe(true);
    stopServe(a.serve); stopServe(b.serve);
    expect(await gone([...a.serve.pids, ...b.serve.pids])).toBe(true);
  }, 30_000);

  test("the serve lists a loosened lock: refused, naming the command, and the server is stopped", async () => {
    const r = await startLockedServe(bin, dir, env("loosened"));
    expect(r.ok).toBe(false);
    if (r.ok) { started.push(...r.serve.pids); return; }
    expect(r.error).toContain("could not vouch for the lock");
    expect(r.error).toMatch(/git push|echo/);
  }, 30_000);

  test.each([
    ["answers something that is not JSON", "garbage", "was not JSON|Unexpected|JSON"],
    ["lists no shell rule", "norules", "no resolved shell rules"],
  ])("a serve that %s is refused", async (_n, mode, why) => {
    const r = await startLockedServe(bin, dir, env(mode));
    expect(r.ok).toBe(false);
    if (r.ok) { started.push(...r.serve.pids); return; }
    expect(r.error).toMatch(new RegExp(why));
  }, 30_000);

  test("a serve that never comes up: refused at the deadline", async () => {
    const t0 = Date.now();
    const r = await startLockedServe(bin, dir, env("nobody"), 1_000);
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(10_000);
    if (!r.ok) expect(r.error).toContain("did not come up");
  }, 30_000);

  test("a role with no lock is refused before anything starts", async () => {
    const r = await startLockedServe(bin, dir, {});
    expect(r).toEqual({ ok: false, error: "the role carries no OpenCode lock" });
  });
});

describe.skipIf(process.platform !== "linux")("the turn is rewritten to run against the checked server, and nowhere else", () => {
  const turn = (e: Record<string, string>) => ({
    ok: true as const, argv: [bin, "run", "--format", "json", "--model", "opencode/x", "--", "do it"], env: e, stdin: "none" as const,
  });

  test("2.x: run --server <url>, the lock left in the server only, the password and pids handed to the client", async () => {
    const g = await guardTurn("opencode", bin, dir, turn(env("holds")));
    expect(g.ok).toBe(true);
    if (!g.ok || !g.serve) throw new Error("no serve");
    started.push(...g.serve.pids);
    expect(g.turn.argv.slice(0, 4)).toEqual([bin, "run", "--server", g.serve.url]);
    expect(g.turn.argv.at(-1)).toBe("do it");
    expect(g.turn.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(g.turn.env.OPENCODE_SERVER_PASSWORD).toBe(g.serve.password);
    expect(g.turn.env.AGX_SERVE_PIDS).toBe(g.serve.pids.join(" "));
    stopServe(g.serve);
    expect(await gone(g.serve.pids)).toBe(true);
  }, 30_000);

  test("2.x with a loosened lock: refused, no turn", async () => {
    const g = await guardTurn("opencode", bin, dir, turn(env("loosened")));
    expect(g.ok).toBe(false);
  }, 30_000);

  test("an OpenCode that will not say its version is treated as 2.x, so it needs the server", async () => {
    const mute = join(dir, "mute");
    writeFileSync(mute, "#!/bin/sh\nexit 1\n"); chmodSync(mute, 0o755);
    const g = await guardTurn("opencode", mute, dir, { ...turn(env("holds")), argv: [mute, "run", "--", "x"] });
    expect(g.ok).toBe(false);
  }, 30_000);

  test("OpenCode 1.x and other engines pass through untouched", async () => {
    const oldBin = join(dir, "opencode-1x");
    writeFileSync(oldBin, FAKE.replace('process.env.FAKE_VERSION ?? "2.1.4"', '"1.4.0"')); chmodSync(oldBin, 0o755);
    const old = { ...turn(env("holds")), argv: [oldBin, "run", "--", "x"] };
    const g = await guardTurn("opencode", oldBin, dir, old);
    expect(g).toEqual({ ok: true, turn: old, serve: null });
    const other = await guardTurn("codex", bin, dir, old);
    expect(other).toEqual({ ok: true, turn: old, serve: null });
  }, 30_000);
});
