import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * A window of four panes comes back with its panes in the order it had.
 *
 * `split-window -t <window>` addresses the window's ACTIVE pane, the first, so
 * every restored pane was inserted right after it: [a, b, c, d] came back as
 * [a, d, c, b], and the layout, which is applied by position, put each
 * directory in the wrong slot. Two panes cannot show it, so this fixture has
 * four. Both resume modes build the same tree.
 *
 * Real tmux on a socket and a state dir of this file's own.
 */

const SOCKET = `agx-restore-ord-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const TMPDIR = join(tmpdir(), `agx-tmux-restore-ord-${process.pid}`);
process.env.AGENTGLASS_STATE_DIR = join(tmpdir(), `agx-restore-ord-state-${process.pid}`);
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const DIRS = ["alpha", "beta", "gamma", "delta"];

let restore: typeof import("../src/tmuxrestore.ts");
let pane: typeof import("../src/tmuxpane.ts");

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  for (const d of DIRS) mkdirSync(join(TMPDIR, d), { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  restore = await import("../src/tmuxrestore.ts");
  pane = await import("../src/tmuxpane.ts");
});

afterAll(async () => {
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* never made */ }
  try { rmSync(process.env.AGENTGLASS_STATE_DIR!, { recursive: true, force: true }); } catch { /* never made */ }
});

const dirsOf = async (session: string) =>
  (await pane.tmux(["list-panes", "-t", `=${session}:`, "-F", "#{pane_current_path}"]))
    .stdout.trim().split("\n").filter(Boolean).map((p) => p.split("/").pop());

for (const mode of ["lazy", "all"] as const) {
  test(`four panes keep their order (${mode})`, async () => {
    const s = `orbit-${mode}`;
    // A desk of its own: the restore keeps a session that is already alive.
    await pane.tmux(["kill-server"]);
    rmSync(process.env.AGENTGLASS_STATE_DIR!, { recursive: true, force: true });
    const at = (d: string) => realpathSync(join(TMPDIR, d));
    // The dying server may still hold the socket for a moment.
    let made = false;
    for (let i = 0; i < 20 && !made; i++) {
      made = (await pane.tmux(["new-session", "-d", "-s", s, "-c", at(DIRS[0])])).ok;
      if (!made) await Bun.sleep(100);
    }
    expect(made).toBe(true);
    // Chained on the pane each split printed, so the fixture itself has the
    // order the restore must reproduce.
    let last = `=${s}:`;
    for (const d of DIRS.slice(1)) {
      const r = await pane.tmux(["split-window", "-d", "-v", "-P", "-F", "#{pane_id}", "-t", last, "-c", at(d)]);
      expect(r.ok).toBe(true);
      last = r.stdout.trim();
    }
    const before = await dirsOf(s);
    expect(before).toEqual(DIRS);

    await restore.captureLayout(Date.now());
    expect((await pane.tmux(["kill-session", "-t", `=${s}`])).ok).toBe(true);
    const r = await restore.restoreLayout(mode);
    expect(r.ok).toBe(true);

    expect(await dirsOf(s)).toEqual(before);
  });
}
