/*
 * With the terminal switched off, the tmux window route must not open a window
 * or a pane: either one runs a command (a shell when no argv is given), which is
 * the terminal by another door. Closing and selecting run nothing and stay.
 * Asserted against a real server started with AGENTGLASS_TERMINAL_DISABLED=1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-tmuxwin-off-"));
let proc: ReturnType<typeof Bun.spawn> | null = null, base = "";

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "t.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_TERMINAL_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
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
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  fetch(base + "/terminal/tmux/windows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /terminal/tmux/windows with the terminal off", () => {
  test("new and split are refused before anything runs", async () => {
    const marker = join(dir, "ran");
    for (const op of ["new", "split"]) {
      const r = await post({ op, session: "orbit", windowId: "@1", cwd: dir, argv: ["sh", "-c", `touch ${marker}`] });
      expect(r.status, op).toBe(403);
      expect(((await r.json()) as { error: string }).error).toContain("terminal is disabled");
    }
    expect(existsSync(marker)).toBe(false);
  });
  test("an op that runs nothing is not refused for that reason", async () => {
    const r = await post({ op: "select-window", session: "orbit", windowId: "@1" });
    expect(r.status).not.toBe(403);
  });
});
