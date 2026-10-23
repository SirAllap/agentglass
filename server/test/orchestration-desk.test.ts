/*
 * Where the desktop app started the server, the policy can be changed only with
 * the desk key: the app's own window holds it, and the machine token every
 * agent shell holds does not stand in for it, with or without the app's Origin.
 *
 * What was wrong: the window sent the token and its Origin and no key, so on a
 * server the app had started, Settings > Orchestration answered "only the person
 * can change the orchestration policy" to the person. The tests that booted a
 * server without a desk never saw it, because there the Origin rule is all
 * there is (orchestration-route.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "orbit-policy-token-0123456789abcdef";
const KEY = "desk-key-the-shell-minted-0123456789abcdefgh";
const APP = "agentglass://app";
let dir: string, base: string, child: ChildProcess | null = null;

const save = (headers: Record<string, string>, root = "/orbit/app") =>
  fetch(base + "/orchestration", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ root, policy: null }),
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-orch-desk-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn("bun", ["run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      CLAUDE_CONFIG_DIR: join(dir, ".claude"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "o.db"),
      AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_DESK_FD: `3:${process.pid}`,
    },
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  const pipe = child.stdio[3] as Writable;
  pipe.on("error", () => { /* it went away before reading */ });
  pipe.end(`${KEY}\n`);
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(() => {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /orchestration on a server the desktop app started", () => {
  test("the app's window, with its key, may change the policy", async () => {
    const r = await save({ origin: APP, "x-agentglass-desk": KEY });
    expect(r.status).toBe(200);
  });
  test("the machine token with the app's Origin and no key is refused", async () => {
    expect((await save({ origin: APP })).status).toBe(403);
  });
  test("the machine token with no Origin and no key is refused", async () => {
    expect((await save({})).status).toBe(403);
  });
  test("a wrong key is refused", async () => {
    expect((await save({ origin: APP, "x-agentglass-desk": KEY + "x" })).status).toBe(403);
  });
});

describe("the window sends the key", () => {
  test("orchestrationSave carries the desk key, as the other person-only calls do", () => {
    const src = readFileSync(new URL("../../web/src/lib/api.ts", import.meta.url), "utf8");
    const at = src.indexOf("orchestrationSave:");
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, src.indexOf("orchestrationState:", at));
    expect(call).toContain("deskHeader()");
  });
});
