/*
 * The `/terminal/pty` guardrail, against a real server rather than the source
 * that claims it.
 *
 * device-scope.test.ts already pins `scopeNeeded("GET", "/terminal/pty") ===
 * "full"` and that `allowed()` returns false for a lesser scope — both pure
 * function calls. Neither one starts a server, so neither one can tell you
 * whether the route actually enforces what the function says: the check could
 * be wired to the wrong branch, or never called at all on this path, and both
 * unit tests would stay green. This file asks the question the other one
 * cannot: boot the real process, open a real socket, and read what came back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "test-machine-token-not-a-real-one";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-ptyguard-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir,
      // State (audit log, ledgers, engine conf) jailed too: without this a booted
      // server writes into the developer's real ~/.local/state/agentglass.
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      // The whole point: the gate has to be live, or an untrusted caller would
      // pass for the wrong reason (no token configured means loopback is nobody).
      AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("/terminal/pty enforces the auth gate at runtime, not just in scopeNeeded()", () => {
  test("an untrusted caller — no credential at all — is refused before any shell opens", async () => {
    // Not a WebSocket client on purpose: the route has to reject this caller
    // before it ever reaches `srv.upgrade`, so a plain fetch already proves the
    // point, and a real 401 body is easier to read than a socket close code.
    const res = await fetch(`${base}/terminal/pty?root=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(401);
    const body = await res.json() as { ok?: boolean };
    expect(body.ok).toBe(false);
  });

  test("an untrusted caller — a wrong token — is refused the same way", async () => {
    const res = await fetch(`${base}/terminal/pty?root=${encodeURIComponent(dir)}&token=not-the-token`);
    expect(res.status).toBe(401);
  });

  test("the machine's own token opens a real PTY socket", async () => {
    const url = `ws://127.0.0.1:${new URL(base).port}/terminal/pty?token=${encodeURIComponent(TOKEN)}&root=${encodeURIComponent(dir)}`;
    const settled = await new Promise<{ opened: boolean }>((resolve) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => { ws.close(); resolve({ opened: true }); });
      ws.addEventListener("error", () => resolve({ opened: false }));
      ws.addEventListener("close", (ev) => { if (ev.code !== 1000) resolve({ opened: false }); });
    });
    expect(settled.opened).toBe(true);
  });
});
