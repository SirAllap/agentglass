/*
 * The `+` opens beside the tab it was pressed on, in that tab's directory.
 *
 * Measured: the tab on screen stood in one project, the panel's remembered
 * checkout still named an ENDED session's worktree in another, and `+` opened a
 * window in the other project's group, in that dead worktree. The panel's
 * `root` is a memory; the focused window's pane is the live answer, asked of
 * tmux when the button is pressed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCwd, runAction, type TmuxTarget } from "../src/tmuxctl.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { settled } from "./paneSettled.ts";

const REAL_TMPDIR = process.env.TMUX_TMPDIR;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;

const SOCK = [...TMUX_ISOLATED, "-L", "agx-new-tab-follows"];
const env = { ...process.env };
delete env.TMUX;
const tmux = (...a: string[]) =>
  Bun.spawnSync(["tmux", ...SOCK, ...a], { stdout: "pipe", stderr: "pipe", env }).stdout.toString().trim();

const base = realpathSync(mkdtempSync(join(tmpdir(), "agx-new-tab-")));
const A = join(base, "agentglass");
const B = join(base, "orbit-ORBIT-1042");
Bun.spawnSync(["mkdir", "-p", A, B]);

afterAll(() => {
  tmux("kill-server");
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
});

describe("the + on the tab strip", () => {
  test("starts beside the focused tab, in its live directory, not the remembered one", async () => {
    // The other project's window first, so "at the end" is not "beside A".
    tmux("new-session", "-d", "-s", "orbit", "-c", B, "sleep", "600");
    const a = tmux("new-window", "-P", "-F", "#{window_id}", "-t", "orbit", "-c", A, "sleep", "600");
    tmux("new-window", "-t", "orbit", "-c", B, "sleep", "600");
    const target: TmuxTarget = { pid: 0, socket: SOCK, session: "orbit", id: tmux("display", "-p", "-t", "orbit", "#{session_id}") };

    const live = await settled(() => paneCwd(SOCK, a), (v) => v === A);
    expect(live).toBe(A);

    expect(runAction(target, "new", a, undefined, undefined, undefined, false, live ?? undefined)).toBe(true);
    const rows = () => tmux("list-windows", "-t", "orbit", "-F", "#{window_index}\t#{window_id}\t#{pane_current_path}")
      .split("\n").map((l) => l.split("\t"));
    const idxA = Number(rows().find((r) => r[1] === a)![0]);
    const born = await settled(() => rows().find((r) => Number(r[0]) === idxA + 1), (r) => r?.[2] === A);
    expect(born?.[2]).toBe(A);
  });

  test("the server asks tmux before it reads what the panel sent", async () => {
    const term = await Bun.file(join(import.meta.dir, "..", "src", "terminal.ts")).text();
    expect(term).toContain('const live = action === "new" && msg.window ? paneCwd(s.tmux.socket, msg.window) : null;');
    expect(term).toContain('const wanted = live ?? (typeof msg.root === "string" ? msg.root : "");');
    const panel = await Bun.file(join(import.meta.dir, "..", "..", "web", "src", "components", "TerminalPanel.tsx")).text();
    expect(panel).toContain('tmuxCmd({ cmd: "new", root, window: focusWin || undefined })');
  });
});
