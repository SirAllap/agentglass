/*
 * A session comes back with all of its windows, or it has not come back.
 *
 * The restore addressed the windows and panes it was rebuilding by the ids in
 * the capture — `@3`, `%7` — which belong to the server that died. So
 * `split-window -t =session:@3` failed for every window after the first, the
 * failure was swallowed by `if (r.ok)`, and a session with six windows came
 * back with one. Measured on a real engine: six in, one out, no names, no
 * scrollback.
 *
 * The test that existed could not see it: its fixture had ONE window with two
 * panes, which is exactly the case the old code got right.
 *
 * Real tmux, on a socket and a state dir of this file's own — nothing here can
 * reach the developer's tmux or their resurrect saves.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCKET = `agx-restore-win-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const TMPDIR = join(tmpdir(), `agx-tmux-restore-win-${process.pid}`);
process.env.AGENTGLASS_STATE_DIR = join(tmpdir(), `agx-restore-win-state-${process.pid}`);
const REAL_TMPDIR = process.env.TMUX_TMPDIR;

let restore: typeof import("../src/tmuxrestore.ts");
let pane: typeof import("../src/tmuxpane.ts");

/** Named the way a person names a session — short, no dashes, nothing
 *  UUID-shaped. That is half of what this file is about. */
const SESSION = "orbit";

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  restore = await import("../src/tmuxrestore.ts");
  pane = await import("../src/tmuxpane.ts");
});

afterAll(async () => {
  /* The kill goes first: a `-L name` socket lives under $TMUX_TMPDIR, so
     restoring the variable before asking tmux to stop pointed the command at
     the developer's own directory and it failed into the catch. See the note
     in tmuxrestore.test.ts and the 216 servers that were still running. */
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* never made */ }
  try { rmSync(process.env.AGENTGLASS_STATE_DIR!, { recursive: true, force: true }); } catch { /* never made */ }
});

test("every window comes back, with its name and its splits", async () => {
  expect((await pane.tmux(["new-session", "-d", "-s", SESSION, "-n", "api", "-c", "/tmp"])).ok).toBe(true);
  expect((await pane.tmux(["new-window", "-d", "-t", `=${SESSION}:`, "-n", "web", "-c", "/tmp"])).ok).toBe(true);
  expect((await pane.tmux(["new-window", "-d", "-t", `=${SESSION}:`, "-n", "logs", "-c", "/tmp"])).ok).toBe(true);
  // A split in the LAST window: the old code only ever populated the first one.
  expect((await pane.tmux(["split-window", "-d", "-v", "-t", `=${SESSION}:logs`, "-c", "/tmp"])).ok).toBe(true);

  const state = await restore.captureLayout(123456);
  const captured = state!.sessions.find((s) => s.name === SESSION)!;
  expect(captured.windows.length).toBe(3);

  expect((await pane.tmux(["kill-session", "-t", `=${SESSION}`])).ok).toBe(true);
  const r = await restore.restoreLayout("lazy");
  expect(r.ok).toBe(true);
  expect(r.restored).toBeGreaterThan(0);

  const windows = (await pane.tmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_name}"]))
    .stdout.trim().split("\n").filter(Boolean);
  expect(windows.length).toBe(3);
  // Names, because a restored desk of "bash, bash, bash" is a desk you have to
  // re-learn.
  expect(windows.sort()).toEqual(["api", "logs", "web"]);

  const logs = (await pane.tmux(["list-panes", "-t", `=${SESSION}:logs`, "-F", "#{pane_id}"]))
    .stdout.trim().split("\n").filter(Boolean);
  expect(logs.length).toBe(2);
});
