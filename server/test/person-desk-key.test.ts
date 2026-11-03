/*
 * Go, No-go and Launch are the person's, and on a server the desktop app
 * started the person is the window that holds the desk key: the server asks for
 * the key and nothing else (no origin, no loopback). The window never sent it
 * on the flight-plan routes (web/src/lib/deskGate.ts did not list them), so the
 * person's Go on a plan an agent wrote was refused as if an agent had pressed
 * it. Asked through a booted server with a key held, with the credentials the
 * window and an agent actually have.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { deskGated } from "../../web/src/lib/deskGate.ts";

const TOKEN = "orbit-flight-token-0123456789abcdef";
const KEY = "desk-key-the-shell-minted-0123456789abcdefgh";
const REFUSED = "the person decides";

let dir = "", base = "", root = "", proc: ChildProcess | null = null, said = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-flight-desk-"));
  root = join(dir, "orbit"); mkdirSync(root);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn("bun", ["run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "", NODE_ENV: "test", TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir,
      XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, ".claude"), AGENTGLASS_ROOT: root,
      AGENTGLASS_DB: join(dir, "flight.db"), AGENTGLASS_TOKEN: TOKEN, AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port), AGENTGLASS_DESK_FD: `3:${process.pid}`,
    },
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  const pipe = proc.stdio[3] as Writable;
  pipe.on("error", () => { /* gone before it read */ });
  pipe.end(`${KEY}\n`);
  proc.stderr?.on("data", (c) => { said = (said + c).slice(-8000); });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + said.slice(0, 400));
}, SERVER_BOOT_MS);
afterAll(() => { proc?.kill(); rmSync(dir, { recursive: true, force: true }); });

const send = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
/** The desktop window: the token, and the key on exactly the routes deskGated lists, as api.ts post() sends it. */
const window = (path: string, body: unknown = {}) => send("POST", path, body, deskGated(path) ? { "x-agentglass-desk": KEY } : {});
/** An agent shell (agentglass-ui, MCP, any --as): the machine token, and the app's origin for good measure. */
const agent = (path: string, body: unknown = { as: "planner" }) => send("POST", path, body, { origin: "agentglass://app" });

/** A plan an agent created and wrote, ready for the person's answer. */
const agentPlan = async (): Promise<string> => {
  const c = await agent("/flight-plan/plans", { root, request: "Cap webhooks per tenant", as: "planner" });
  expect(c.status).toBe(200);
  const id = c.body.plan.id as string;
  expect((await send("PATCH", `/flight-plan/plans/${id}`, { plan_md: "## Plan\nOne table, one limit.", as: "planner" })).body.plan.state).toBe("ready");
  return id;
};

describe("flight plan through the window's own credentials", () => {
  test("the person's routes are on the list the web client sends the key for", () => {
    for (const p of ["/flight-plan/plans", "/flight-plan/plans/fp_0123456789abcdef/go", "/flight-plan/plans/fp_0123456789abcdef/no-go",
      "/flight-plan/plans/fp_0123456789abcdef/launch", "/flight-plan/plans/fp_0123456789abcdef/preflight", "/flight-plan/runs/pf_0123456789abcdef/go"]) {
      expect(deskGated(p)).toBe(true);
    }
  });

  test("the window turns Flight plan on", async () => {
    expect((await window("/settings/door", { id: "flightPlan.enabled", value: true })).status).toBe(200);
  });

  test("the person says Go on a plan an agent wrote, then No-go", async () => {
    // This file is about whose credentials count, not about a review before Go (flight-plan-fixes.test.ts).
    expect((await window("/settings/door", { id: "flightPlan.preflight.reviews", value: [], root })).status).toBe(200);
    const id = await agentPlan();
    const go = await window(`/flight-plan/plans/${id}/go`);
    expect(go.status).toBe(200);
    expect(go.body.plan.state).toBe("go");   // no terminal here, so the launch Go tries says why it could not
    const no = await window(`/flight-plan/plans/${id}/no-go`, { reason: "Split it: retries first" });
    expect(no.status).toBe(200);
    expect(no.body.plan.state).toBe("no-go");
  });

  test("the person's Launch and one-run cap pass the gate (what answers is the plan's state, not who asked)", async () => {
    const id = await agentPlan();
    const l = await window(`/flight-plan/plans/${id}/launch`);
    expect(l.status).toBe(409);
    expect(l.body.error).toContain("needs Go first");
    expect((await window(`/flight-plan/plans/${id}/preflight`, { capUsd: 1 })).status).not.toBe(403);
    expect((await window("/flight-plan/runs/pf_0123456789abcdef/go")).status).toBe(404);
  });

  test("the person's new plan starts the author tab; an agent's does not", async () => {
    expect(typeof (await window("/flight-plan/plans", { root, request: "Retry failed webhooks" })).body.ticket).toBe("string");
    expect((await agent("/flight-plan/plans", { root, request: "Retry failed webhooks", as: "planner" })).body.ticket).toBeNull();
  });

  test("an agent is refused Go, No-go and Launch on every credential it holds", async () => {
    const id = await agentPlan();
    for (const v of ["go", "no-go", "launch"]) {
      const r = await agent(`/flight-plan/plans/${id}/${v}`, { as: "planner", reason: "x" });
      expect(r.status).toBe(403);
      expect(r.body.error).toContain(REFUSED);
    }
    // Loopback without the key is not the person.
    expect((await send("POST", `/flight-plan/plans/${id}/go`, {}, { origin: base })).status).toBe(403);
    // Naming itself an agent loses the key's say, even if it got hold of one.
    expect((await send("POST", `/flight-plan/plans/${id}/go`, {}, { "x-agentglass-desk": KEY, "x-agentglass-agent": "planner" })).status).toBe(403);
    // A wrong key is no key.
    expect((await send("POST", `/flight-plan/plans/${id}/go`, {}, { "x-agentglass-desk": "not-the-key" })).status).toBe(403);
    expect((await agent("/flight-plan/runs/pf_0123456789abcdef/go")).status).toBe(403);
    expect((await agent(`/flight-plan/plans/${id}/preflight`, { capUsd: 1, as: "planner" })).status).toBe(403);
    expect((await fetch(`${base}/flight-plan/plans/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json()) as { plan: { state: string } }).plan.state).toBe("ready");
  });
});

describe("agent rules through the window's own credentials", () => {
  test("the routes are on the list the web client sends the key for", () => {
    expect(deskGated("/agent-rules")).toBe(true);
    expect(deskGated("/agent-rules/ar_0123456789abcdef01/answer")).toBe(true);
  });

  test("the person's looser rule applies at once; an agent's waits, and only the person answers it", async () => {
    expect((await window("/agent-rules", { root, match: "Bash(git push:*)", setting: "never" })).body.applied).toBe(true);
    const own = await window("/agent-rules", { root, match: "Bash(git push:*)", setting: "allow" });
    expect(own.status).toBe(200);
    expect(own.body.applied).toBe(true);
    const asked = await agent("/agent-rules", { root, match: "Bash(rm:*)", setting: "allow", as: "planner" });
    expect(asked.status).toBe(202);
    const id = asked.body.rule.id as string;
    expect((await agent(`/agent-rules/${id}/answer`, { setting: "allow" })).status).toBe(403);
    expect((await send("POST", `/agent-rules/${id}/answer`, { setting: "allow" }, { "x-agentglass-desk": KEY, "x-agentglass-agent": "planner" })).status).toBe(403);
    expect((await window(`/agent-rules/${id}/answer`, { setting: "allow" })).status).toBe(200);
  });
});
