/*
 * A WINDOW COMES BACK SPLIT THE WAY IT WAS.
 *
 * The photograph had the windows and their panes and not how they were
 * split; the restore always split top-to-bottom, so a window cut side by side
 * came back cut the other way (measured on a real two-pane window). tmux
 * describes the geometry in one string (`#{window_layout}`) and takes it back
 * through `select-layout`. This drives a real tmux on its own socket: a
 * session with one window split left/right, captured, the server killed, the
 * layout restored — and the restored window's layout string read back.
 *
 * Broken on purpose before it was believed: with `applyLayout` returning
 * early the window comes back with two panes stacked, and the last case is
 * red.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";

const SOCKET = `agx-splits-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const TMPDIR = join(tmpdir(), `agx-splits-tmp-${process.pid}`);
process.env.AGENTGLASS_STATE_DIR = join(tmpdir(), `agx-splits-state-${process.pid}`);
process.env.AGENTGLASS_RESTORE_SETTLE_MS = "300";
const REAL_TMPDIR = process.env.TMUX_TMPDIR;

let restore: typeof import("../src/tmuxrestore.ts");
let pane: typeof import("../src/tmuxpane.ts");
const have = !!Bun.which("tmux");
const S = `agxsplits${process.pid}`;

/** The shape of a layout without its sizes: `{` is side by side, `[` is
 *  stacked — the one character this whole file is about. */
const shape = (layout: string) => layout.replace(/[0-9a-f]{4},/, "").replace(/\d+x\d+,\d+,\d+(,\d+)?/g, "P");
/** kill-server returns while the old server is still on its way out; a
 *  new-session that arrives before the socket is released lands on the dying
 *  server and is refused. Measured on the CI runner, never on a developer
 *  machine: the difference was only how fast tmux exits. So: kill, then wait
 *  for list-sessions to fail, then build. */
const killAndWait = async () => {
  await pane.tmux(["kill-server"]).catch(() => null);
  for (let i = 0; i < 100; i++) {
    const r = await pane.tmux(["list-sessions"]).catch(() => ({ ok: false }));
    if (!r.ok) return;
    await Bun.sleep(50);
  }
};

const layoutOf = async (session: string) => {
  const r = await pane.tmux(["list-windows", "-t", `=${session}`, "-F", "#{window_layout}"]);
  return r.ok ? r.stdout.trim().split("\n")[0] ?? "" : "";
};

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  restore = await import("../src/tmuxrestore.ts");
  pane = await import("../src/tmuxpane.ts");
});

afterAll(async () => {
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  /* The belt for a server the module could not reach: the raw binary, on
     this suite's own socket, with the empty configuration every test uses. */
  Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-L", SOCKET, "kill-server"], { env: { ...process.env, TMUX_TMPDIR: TMPDIR }, stdout: "ignore", stderr: "ignore" });
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  rmSync(TMPDIR, { recursive: true, force: true });
  rmSync(process.env.AGENTGLASS_STATE_DIR!, { recursive: true, force: true });
});

describe.skipIf(!have)("the splits", () => {
  test("a side-by-side window is photographed with its layout and comes back side by side", async () => {
    restore.__resetRestoreState();
    const mk = await pane.tmux(["new-session", "-d", "-s", S, "-x", "200", "-y", "50", "-c", "/tmp", "sleep 60"]);
    expect(mk.ok, mk.stderr).toBe(true);
    const split = await pane.tmux(["split-window", "-h", "-d", "-t", `${S}:0`, "-c", "/tmp", "sleep 60"]);
    expect(split.ok, split.stderr).toBe(true);
    const before = await layoutOf(S);
    expect(shape(before), before).toBe("P{P,P}");

    const state = await restore.captureLayout();
    const win = state?.sessions.find((s) => s.name === S)?.windows[0];
    expect(win?.layout, "the photograph carries tmux's own layout string").toBe(before);
    expect(win?.panes).toHaveLength(2);

    await killAndWait();
    const back = await restore.restoreLayout("lazy");
    expect(back.ok, back.error).toBe(true);
    const after = await layoutOf(S);
    expect(after, "the window is back").not.toBe("");
    expect(shape(after), `before ${before} · after ${after}`).toBe("P{P,P}");
  });

  test("a stacked window comes back stacked, and a window of one pane is left alone", async () => {
    await killAndWait();
    restore.__resetRestoreState();
    const mk = await pane.tmux(["new-session", "-d", "-s", S, "-x", "200", "-y", "50", "-c", "/tmp", "sleep 60"]);
    expect(mk.ok, mk.stderr).toBe(true);
    await pane.tmux(["split-window", "-v", "-d", "-t", `${S}:0`, "-c", "/tmp", "sleep 60"]);
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-c", "/tmp", "sleep 60"]);
    const before = await pane.tmux(["list-windows", "-t", `=${S}`, "-F", "#{window_layout}"]);
    const [stacked = "", single = ""] = before.stdout.trim().split("\n");
    expect(shape(stacked)).toBe("P[P,P]");
    expect(shape(single)).toBe("P");
    await restore.captureLayout();
    await killAndWait();
    expect((await restore.restoreLayout("lazy")).ok).toBe(true);
    const after = await pane.tmux(["list-windows", "-t", `=${S}`, "-F", "#{window_layout}"]);
    const shapes = after.stdout.trim().split("\n").map(shape);
    expect(shapes).toEqual(["P[P,P]", "P"]);
  });

  test("a layout string is refused when the pane count does not match, and never reaches -t unvalidated", async () => {
    await killAndWait();
    await pane.tmux(["new-session", "-d", "-s", S, "-x", "200", "-y", "50", "-c", "/tmp", "sleep 60"]);
    const one = (await pane.tmux(["list-windows", "-t", `=${S}`, "-F", "#{window_id}"])).stdout.trim();
    expect(await restore.applyLayout(S, one, "4b44,200x50,0,0{100x50,0,0,1,99x50,101,0,2}", 2), "two wanted, one present").toBe(false);
    expect(await restore.applyLayout(S, one, "; kill-server", 1)).toBe(false);
    expect(await restore.applyLayout(S, one, undefined, 2)).toBe(false);
  });
});
