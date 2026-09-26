/*
 * A TAB CLOSED WHILE THE APP WAS DOWN STAYS CLOSED.
 *
 * `settled` lives in one process's memory, so a fresh boot started with the
 * desk not put back and read every window missing from the tmux server as
 * "lost with a crash": a tab closed on purpose while the app was not running
 * came back at the next start. The signal that tells the two apart is the tmux
 * server itself: the photograph records the server it was taken on
 * (`pid.start_time`), and a server that is still the same one never crashed,
 * so whatever is missing from it was closed. A different server is the crash
 * the merge exists for, and that path is unchanged.
 *
 * Real tmux on its own socket and its own state directory.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { LANTERN_PROMPT_MARK } from "../src/lanternmark.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCKET = `agx-down-${process.pid}`;
const TMPDIR = join(tmpdir(), `agx-down-tmp-${process.pid}`);
const STATE = join(tmpdir(), `agx-down-state-${process.pid}`);
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const REAL_STATE = process.env.AGENTGLASS_STATE_DIR;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;

let restore: typeof import("../src/tmuxrestore.ts");
let pane: typeof import("../src/tmuxpane.ts");

const P = `agxdownP${process.pid}`;
const Q = `agxdownQ${process.pid}`;

type Layout = { sessions: { name: string; windows: { name?: string }[] }[] };
const layout = (): Layout | null => {
  try { return JSON.parse(readFileSync(join(STATE, "tmux", "restore", "layout.json"), "utf8")); } catch { return null; }
};
const names = () => (layout()?.sessions ?? []).map((s) => s.name);
const windowsOf = (s: string) => (layout()?.sessions.find((x) => x.name === s)?.windows ?? []).map((w) => w.name);
const liveWindows = async (s: string) =>
  (await pane.tmux(["list-windows", "-t", `=${s}`, "-F", "#{window_name}"])).stdout.split("\n").filter(Boolean);

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
  process.env.AGENTGLASS_STATE_DIR = STATE;
  process.env.TMUX_TMPDIR = TMPDIR;
  restore = await import("../src/tmuxrestore.ts");
  pane = await import("../src/tmuxpane.ts");
});

afterAll(async () => {
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  const put = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  put("AGENTGLASS_TMUX_SOCKET", REAL_SOCKET);
  put("AGENTGLASS_STATE_DIR", REAL_STATE);
  put("TMUX_TMPDIR", REAL_TMPDIR);
  for (const d of [TMPDIR, STATE]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* never made */ } }
});

const settle = async () => { for (let i = 0; i < 50 && restore.isRestoring(); i++) await Bun.sleep(100); };

test("a window and a session closed while the app was down are not rebuilt at the next boot", async () => {
  /* A first boot: nothing recorded, nothing running, so whatever tmux starts
     next is the desk's. */
  await restore.restoreLayout("lazy");
  expect((await pane.tmux(["new-session", "-d", "-s", P, "-n", "one", "-c", "/tmp", "sleep", "300"])).ok).toBe(true);
  expect((await pane.tmux(["new-window", "-d", "-t", `=${P}:`, "-n", "extra", "-c", "/tmp", "sleep", "300"])).ok).toBe(true);
  expect((await pane.tmux(["new-session", "-d", "-s", Q, "-c", "/tmp", "sleep", "300"])).ok).toBe(true);
  await restore.captureLayout();
  expect(windowsOf(P)).toContain("extra");
  expect(names()).toContain(Q);

  /* The app is down: nothing photographs, and a person closes two things. */
  await pane.tmux(["kill-window", "-t", `=${P}:extra`]);
  await pane.tmux(["kill-session", "-t", `=${Q}`]);
  /* The next boot: a new process, the desk not yet put back. */
  restore.__resetRestoreSettled();
  await restore.restoreLayout("lazy");
  expect(await liveWindows(P), "a window closed while the app was down came back").not.toContain("extra");
  expect((await pane.tmux(["has-session", "-t", `=${Q}`])).ok, "a session closed while the app was down came back").toBe(false);

  /* And the record follows the desk. */
  await restore.captureLayout();
  expect(windowsOf(P)).not.toContain("extra");
  expect(names()).not.toContain(Q);
}, 30_000);

test("a window lost with the tmux server itself is still rebuilt", async () => {
  expect((await pane.tmux(["new-window", "-d", "-t", `=${P}:`, "-n", "extra", "-c", "/tmp", "sleep", "300"])).ok).toBe(true);
  await restore.captureLayout();
  expect(windowsOf(P)).toContain("extra");

  await pane.tmux(["kill-server"]);
  await Bun.sleep(300);
  restore.__resetRestoreSettled();
  await restore.restoreLayout("lazy");
  await settle();
  expect(await liveWindows(P), "a crash lost the window and it was not rebuilt").toContain("extra");
}, 30_000);
