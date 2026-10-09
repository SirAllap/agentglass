/*
 * /terminal/panes says which group a window was put in by hand and whether it
 * is pinned, so the phone can sort its window switcher the way the desk sorts
 * its strip.
 *
 * Both are tmux window options (`@agx-group`, `@agx-pin`) that the desk already
 * reads for its own list; the pane route did not carry them, so the phone could
 * only group by project and could not put the orchestrator's window first.
 * Driven against a real, isolated tmux and a real server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  dir = mkdtempSync(join(tmpdir(), "agx-panegroup-"));
  socket = `agx-pg-${dir.slice(dir.lastIndexOf("-") + 1)}`;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMUX_TMPDIR: dir,
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: dir,
      XDG_CACHE_HOME: dir,
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

type Row = { windowName: string; group?: string; pinned?: boolean };
const panes = async (): Promise<Row[]> =>
  ((await (await fetch(base + "/terminal/panes")).json()) as { panes: Row[] }).panes;

describe("GET /terminal/panes: a window's hand-set group and pin", () => {
  test("a grouped, pinned window says so; one nobody touched says nothing", async () => {
    if (!HAVE_TMUX) return;
    tmux("new-session", "-d", "-s", "orbit", "-n", "Orchestrator", "-c", dir, "sleep", "300");
    tmux("new-window", "-t", "orbit", "-n", "orbit-1042-sync", "-c", dir, "sleep", "300");
    tmux("set-option", "-w", "-t", "orbit:Orchestrator", "@agx-group", "ops");
    tmux("set-option", "-w", "-t", "orbit:Orchestrator", "@agx-pin", "1");

    const rows = await panes();
    const orchestrator = rows.find((p) => p.windowName === "Orchestrator");
    const worker = rows.find((p) => p.windowName === "orbit-1042-sync");
    expect(orchestrator).not.toBeUndefined();
    expect(worker).not.toBeUndefined();
    expect(orchestrator!.group).toBe("ops");
    expect(orchestrator!.pinned).toBe(true);
    // Absent, not "" and not false: the phone reads absence as "by project".
    expect("group" in worker!).toBe(false);
    expect("pinned" in worker!).toBe(false);
  });

  test("a group set from tmux's own command line is cleaned like the desk cleans it", async () => {
    if (!HAVE_TMUX) return;
    tmux("set-option", "-w", "-t", "orbit:orbit-1042-sync", "@agx-group", "  " + "x".repeat(40) + "  ");
    const worker = (await panes()).find((p) => p.windowName === "orbit-1042-sync");
    expect(worker!.group).toBe("x".repeat(32));
  });

  test("a tab or a newline in a group cannot cost the window its pin or its place", async () => {
    if (!HAVE_TMUX) return;
    // Anyone can `set -w @agx-group` with anything. A tab added a field, so the
    // pin was lost and the path gained a junk prefix; a newline cut the row in
    // two and the window was left out of the list altogether.
    tmux("new-window", "-a", "-t", "orbit", "-n", "orbit-1043-tabs", "-c", dir, "sleep", "300");
    tmux("set-option", "-w", "-t", "orbit:orbit-1043-tabs", "@agx-group", "ops\tx\nz");
    tmux("set-option", "-w", "-t", "orbit:orbit-1043-tabs", "@agx-pin", "1");
    const rows = await panes();
    const w = rows.find((p) => p.windowName === "orbit-1043-tabs") as (Row & { path?: string }) | undefined;
    expect(w).not.toBeUndefined();
    expect(w!.pinned).toBe(true);
    expect(w!.group).toBe("ops x z");
    expect(w!.path).toBe(dir);
    // And the rows around it are still there.
    expect(rows.find((p) => p.windowName === "Orchestrator")).not.toBeUndefined();
  });
});
