/**
 * The ten second layout photograph must cost a fixed handful of tmux calls,
 * and must not rewrite a file that says the same thing.
 *
 * Measured on a desk of 24 sessions with 3 windows each: the sweep asked tmux
 * once per session, per window and per pane (170 sequential spawns a tick,
 * about 760 ms, 1000 a minute) and rewrote layout.json every tick with only
 * `capturedAt` changed. A counting shim stands in for tmux (`AGENTGLASS_TMUX_PATH`)
 * so the count is what the server really spawned, against a real tmux on its
 * own socket under a private TMUX_TMPDIR.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync, statSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const SOCK = `agx-batch-${process.pid}`;
const ROOT = mkdtempSync(join(tmpdir(), "agxb-"));
const STATE = join(ROOT, "state");
const TMPDIR = join(ROOT, "t");
const LOG = join(ROOT, "calls.log");
const SESSIONS = Number(process.env.AGX_BATCH_SESSIONS) || 8;
const realTmux = Bun.which("tmux") || "/usr/bin/tmux";
const sock = ["-f", "/dev/null", "-L", SOCK];
const sh = (a: string[]) => Bun.spawnSync(["env", "-u", "TMUX", realTmux, ...sock, ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMUX_TMPDIR: TMPDIR } });
const calls = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).length : 0);
const layoutFile = () => join(STATE, "tmux", "restore", "layout.json");

let restore: typeof import("../src/tmuxrestore.ts");
const saved = { ...process.env };

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  const shim = join(ROOT, "tmux-shim");
  writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${LOG}"\nexec "${realTmux}" "$@"\n`);
  chmodSync(shim, 0o755);
  process.env.TMUX_TMPDIR = TMPDIR;
  process.env.AGENTGLASS_TMUX_SOCKET = SOCK;
  process.env.AGENTGLASS_STATE_DIR = STATE;
  process.env.AGENTGLASS_TMUX_PATH = shim;
  delete process.env.TMUX;
  restore = await import("../src/tmuxrestore.ts");
  /* The engine's config, so a pane whose command dies at boot is KEPT, dead,
     as the real engine keeps it (`remain-on-exit failed`). Without it the
     restored server has `remain-on-exit off`, and the fixture's `bash -c` pane
     (a command with a newline in it, cut short by the capture) closes as soon
     as it exits: when the split reaches the window first, the window survives
     with only the split's pane, which is now index 0 and in the wrong
     directory. Measured under load, 11 runs in 30. Written by hand:
     `ensureConf` remembers the content it last wrote, and every test file
     shares one process. */
  const conf = await import("../src/tmuxconf.ts");
  mkdirSync(dirname(conf.confPath()), { recursive: true });
  writeFileSync(conf.confPath(), conf.confContent());
  for (let i = 0; i < SESSIONS; i++) {
    sh(["new-session", "-d", "-s", `desk${i}`, "-c", "/tmp"]);
    sh(["new-window", "-d", "-t", `=desk${i}`, "-n", "w2", "-c", "/tmp"]);
    sh(["new-window", "-d", "-t", `=desk${i}`, "-n", "w3", "-c", "/tmp", "sleep 600"]);
  }
});

afterAll(() => {
  sh(["kill-server"]);
  for (const k of ["TMUX_TMPDIR", "AGENTGLASS_TMUX_SOCKET", "AGENTGLASS_STATE_DIR", "AGENTGLASS_TMUX_PATH"]) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* gone */ }
});

test("a tick costs a fixed handful of tmux calls, not one per session, window and pane", async () => {
  await restore.captureLayout();                  // first tick: writes the file
  const before = calls();
  const t0 = performance.now();
  await restore.captureLayout();
  const perTick = calls() - before;
  console.log(`tmux calls per tick at ${SESSIONS} sessions x 3 windows: ${perTick} in ${Math.round(performance.now() - t0)} ms`);
  expect(perTick).toBeLessThanOrEqual(4);
  const state = JSON.parse(readFileSync(layoutFile(), "utf8"));
  expect(state.sessions.length).toBe(SESSIONS);
  const d0 = state.sessions.find((s: { name: string }) => s.name === "desk0");
  expect(d0.windows.length).toBe(3);
  expect(d0.windows[2].name).toBe("w3");
  expect(d0.windows[2].panes[0].startCommand, "the born-with command still travels").toContain("sleep 600");
});

test("a tick that saw nothing new does not rewrite the file", async () => {
  await restore.captureLayout();
  const ino = statSync(layoutFile()).ino;
  const mtime = statSync(layoutFile()).mtimeMs;
  await Bun.sleep(30);
  await restore.captureLayout();
  expect(statSync(layoutFile()).ino, "a rename would give the file a new inode").toBe(ino);
  expect(statSync(layoutFile()).mtimeMs).toBe(mtime);
  expect(restore.lastCaptureAt(), "the settings page still shows the sweep as fresh").toBeGreaterThan(mtime - 1);
});

test("the batch photographs exactly what asking one session, window and pane at a time does", async () => {
  /* The layout file is what puts a desk back after a power cut, so the cheaper
     read must agree with the old one in every field a restore uses: window
     order, names, layouts, each pane's cwd, pid and born-with command. The
     command here holds a tab and a newline, which a line-based read would split. */
  sh(["new-window", "-d", "-t", "=desk2", "-n", "w5", "-c", "/usr", "sleep 600\n# a\tb"]);
  sh(["split-window", "-d", "-t", "=desk2:w5", "-c", "/var", "sleep 601"]);
  await Bun.sleep(1500);                          // a pane forked a moment ago still reads as the tmux binary
  const { windowTree, allWindowTrees } = await import("../src/tmuxlayout.ts");
  const batch = await allWindowTrees();
  expect(batch).not.toBeNull();
  let panes = 0;
  for (let i = 0; i < SESSIONS; i++) {
    const name = `desk${i}`;
    const slow = await windowTree(name);
    expect(batch!.trees.get(name), name).toEqual(slow);
    for (const w of slow) for (const p of w.panes) {
      panes++;
      const one = sh(["display-message", "-t", `=${name}:${w.id}.${p.id}`, "-p", "#{pane_start_command}"]).stdout.toString().trim();
      expect(batch!.starts.get(p.id), `${name} ${p.id}`).toBe(one);
    }
  }
  expect(panes).toBeGreaterThan(SESSIONS * 3);
  const w5 = batch!.trees.get("desk2")!.find((w) => w.name === "w5")!;
  expect(w5.panes.map((p) => p.path)).toEqual(["/usr", "/var"]);
});

test("a change is written at once", async () => {
  sh(["new-window", "-d", "-t", "=desk1", "-n", "w4", "-c", "/tmp"]);
  await restore.captureLayout();
  const state = JSON.parse(readFileSync(layoutFile(), "utf8"));
  const d1 = state.sessions.find((s: { name: string }) => s.name === "desk1");
  expect(d1.windows.map((w: { name: string }) => w.name)).toContain("w4");
});

test("a layout captured after the change puts the desk back as it was after a power cut", async () => {
  await Bun.sleep(1500);                          // forked panes settle (see above)
  await restore.captureLayout();
  const list = (a: string[]) => sh(a).stdout.toString().trim().split("\n").filter(Boolean);
  /* Per session: each window's name with the directories of its panes, in
     order. Indexes are left out: the engine's config counts from 1 and the
     fixture's server from 0, and the ORDER is what a restore has to keep. The engine's own first window is left out: `restoreLayout` makes a
     session with one blank window of its own, before and after this change. */
  const shape = () => list(["list-sessions", "-F", "#{session_name}"]).sort().map((n) => [
    n,
    list(["list-panes", "-s", "-t", `=${n}`, "-F", "#{window_index} #{window_name} #{pane_current_path}"])
      .map((l) => l.split(" ").slice(1)).filter((l) => l[0] !== "tmux"),
  ]);
  const before = shape();
  expect(before.length).toBe(SESSIONS);
  sh(["kill-server"]);                            // the power cut: the file is all that is left
  expect(list(["list-sessions"]).length).toBe(0);
  const r = await restore.restoreLayout("all");
  expect(r.ok).toBe(true);
  /* Same sessions, the same windows in the same order with the same names, and
     every pane in the directory it was in. */
  expect(shape()).toEqual(before);
});
