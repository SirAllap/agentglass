/*
 * The empty state's "Open a shell in <project>" — a window with no pane to
 * anchor it to.
 *
 * `cmd:"agent"` over the terminal WebSocket reads its project off the pane the
 * socket is attached to, which is the whole point of it — but the empty state
 * has no pane and, since `TerminalView` only mounts `if (open)`, no socket at
 * all. `/terminal/open-shell` is the same window-opening call with the project
 * taken from the request body instead, driven against a real, isolated tmux.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { freePort } from "./freePort.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

let dir = "", base = "", socket = "", proc: ReturnType<typeof Bun.spawn> | null = null;
const HAVE_TMUX = !!Bun.which("tmux") && existsSync("/proc");

const tmux = (...args: string[]) =>
  Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-L", socket, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMUX_TMPDIR: dir },
    stdout: "pipe", stderr: "pipe",
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-openshell-"));
  socket = `agx-os-${dir.slice(dir.lastIndexOf("-") + 1)}`;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMUX_TMPDIR: dir,
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TMUX_SOCKET: socket,
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
  try { if (HAVE_TMUX && socket) tmux("kill-server"); } catch { /* never started one */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const open = (root: unknown) =>
  fetch(base + "/terminal/open-shell", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root }),
  });

describe("POST /terminal/open-shell", () => {
  test("opens a window in the named project, with no pane in play", async () => {
    if (!HAVE_TMUX) return;
    const r = await open(dir);
    const body = await r.json() as Record<string, unknown>;
    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.pane).toMatch(/^%\d+$/);
    expect(body.session).toBeTruthy();
    const ls = tmux("list-panes", "-a", "-F", "#{pane_current_path}");
    expect(new TextDecoder().decode(ls.stdout)).toContain(dir);
  });

  // A shell made from the phone is on the app's own tmux server with nobody
  // attached to it, and no tmux-last.json names that server on a machine where
  // the desk never attached. The pane list used to skip such a server as a
  // stray, so the window existed and could not be attached: the phone showed
  // Disconnected. The app's own server is never a stray.
  test("the window it opens is listed and attachable, with no client and no remembered server", async () => {
    if (!HAVE_TMUX) return;
    const root = join(dir, "orbit");
    mkdirSync(root);
    const opened = await (await open(root)).json() as { pane: string };
    expect(opened.pane).toMatch(/^%\d+$/);
    const rows = (await (await fetch(base + "/terminal/panes")).json() as { panes: { paneId: string; own?: boolean }[] }).panes;
    const row = rows.find((p) => p.paneId === opened.pane);
    expect(row).not.toBeUndefined();
    expect(row!.own).toBe(true);
  });

  test("refuses a directory that does not exist", async () => {
    if (!HAVE_TMUX) return;
    const r = await open(join(dir, "not-a-real-checkout"));
    expect(r.status).toBe(400);
    expect((await r.json() as Record<string, unknown>).ok).toBe(false);
  });

  test("refuses a body with no root at all", async () => {
    const r = await open(undefined);
    expect(r.status).toBe(400);
  });
});
