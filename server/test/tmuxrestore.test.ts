// Layout capture and restore, against the machine's real tmux — the same
// guarded pattern as chat-pane.test.ts: our own socket, our own TMUX_TMPDIR,
// our own state dir. Nothing reaches the developer's tmux or their resurrect
// saves, and the whole sandbox is removed afterwards.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCKET = `agx-restore-test-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const TMPDIR = join(tmpdir(), `agx-tmux-restore-${process.pid}`);
process.env.AGENTGLASS_STATE_DIR = join(tmpdir(), `agx-restore-state-${process.pid}`);
const REAL_TMPDIR = process.env.TMUX_TMPDIR;

let restore: typeof import("../src/tmuxrestore.ts");
let pane: typeof import("../src/tmuxpane.ts");

// uuid-shaped: validPaneName() gates every name the restore machinery touches
const SESSION = `ab12cd34-0000-4000-8000-${String(process.pid).padStart(12, "0")}`;

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  restore = await import("../src/tmuxrestore.ts");
  pane = await import("../src/tmuxpane.ts");
});

afterAll(async () => {
  /*
   * KILL THE SERVER FIRST, WHILE ITS SOCKET IS STILL FINDABLE.
   *
   * This restored TMUX_TMPDIR and *then* asked tmux to stop — and a `-L name`
   * socket lives under $TMUX_TMPDIR, so by then the command was looking in the
   * developer's own tmux directory, finding nothing, and failing into the
   * silent catch. The sandbox server survived every run.
   *
   * Measured on this machine: 216 of them, holding 827MB and keeping deleted
   * worktrees open, the oldest 23 hours old. Removing TMPDIR does not help —
   * deleting a socket file does not stop the process listening on it, which is
   * exactly what those 216 were: live servers with a deleted socket.
   */
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* never made */ }
  try { rmSync(process.env.AGENTGLASS_STATE_DIR!, { recursive: true, force: true }); } catch { /* never made */ }
});

test("captureLayout writes the tree of a live session", async () => {
  const mk = await pane.tmux(["new-session", "-d", "-s", SESSION, "-c", "/tmp"]);
  expect(mk.ok).toBe(true);
  // A second pane so the tree has a split to capture.
  // Bare `-t NAME`: `=NAME` ("can't find pane") and `NAME:0` ("can't find
  // window: 0") both fail against a uuid-ish session name on tmux 3.6a, while
  // the @-style ids the engine actually targets resolve fine.
  const sp = await pane.tmux(["split-window", "-d", "-v", "-t", SESSION, "-c", "/tmp"]);
  expect(sp.ok).toBe(true);

  const state = await restore.captureLayout(123456);
  expect(state).not.toBeNull();
  expect(state!.sessions.some((s) => s.name === SESSION)).toBe(true);
  const s = state!.sessions.find((x) => x.name === SESSION)!;
  expect(s.windows.length).toBeGreaterThan(0);
  expect(s.windows[0].panes.length).toBeGreaterThanOrEqual(2);
  /* No scrollback file, and on purpose: the replay was removed. The only way
     tmux offers to put text into a pane is as INPUT, so a restored pane's live
     shell ran the old screen — "Unknown command: Enter". The desk is what is
     worth rebuilding; the text that scrolled past is not. */
  expect(existsSync(join(process.env.AGENTGLASS_STATE_DIR!, "tmux", "restore", SESSION, `${s.windows[0].panes[0].id}.txt`))).toBe(false);
});

test("restoreLayout rebuilds a session that no longer exists and skips a live one", async () => {
  const killed = await pane.tmux(["kill-session", "-t", `=${SESSION}`]);
  expect(killed.ok).toBe(true);

  const r = await restore.restoreLayout("lazy");
  expect(r.ok).toBe(true);
  expect(r.restored).toBeGreaterThan(0);

  const have = await pane.tmux(["has-session", "-t", `=${SESSION}`]);
  expect(have.ok).toBe(true);

  // Second call: the session exists again, so nothing is restored twice.
  const again = await restore.restoreLayout("lazy");
  expect(again.restored).toBe(0);

  // The restored layout still has the split from the capture.
  const panes = await pane.tmux(["list-panes", "-t", `=${SESSION}`, "-F", "#{pane_id}"]);
  expect(panes.stdout.trim().split("\n").length).toBeGreaterThanOrEqual(2);
});

test("restoreLayout with no captured state says so instead of guessing", async () => {
  restore.clearRestoreState();
  const r = await restore.restoreLayout("lazy");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("nothing captured");
});

test("the captured layout is readable back from disk without tmux", async () => {
  await restore.captureLayout();
  const state = restore.readRestoreState();
  expect(state).not.toBeNull();
  expect(state!.sessions.length).toBeGreaterThan(0);
});
