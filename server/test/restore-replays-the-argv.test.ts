/*
 * WHAT WAS RUNNING COMES BACK AS THE ARGV IT WAS RUNNING WITH.
 *
 * The photograph used to keep `#{pane_start_command}` and the restore ran it
 * through `sh -c`. tmux reports that string already quoted for a shell — a
 * window made from one string, `tmux new-window "exec claude --model …"`,
 * comes back as `"exec claude --model …"` with the quotes on (measured on
 * tmux 3.7c, `args_escape`) — so `sh -c` went looking for a program called
 * `exec claude --model …`, found none, and the window died in the same
 * second. `keepTheDesk` then put a shell in its place: after a reboot the
 * owner's tabs were all shells, and the count said restored. A window made
 * from several arguments survived, one `sh -c` deeper per restart.
 *
 * So the photograph now holds what the pane's process is running, as argv
 * read off the process, and the restore hands that argv to tmux as it is:
 * exact, and never one level deeper.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCKET = `agx-argv-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const TMPDIR = join(tmpdir(), `agx-argv-tmp-${process.pid}`);
process.env.AGENTGLASS_STATE_DIR = join(tmpdir(), `agx-argv-state-${process.pid}`);
process.env.AGENTGLASS_RESTORE_SETTLE_MS = "400";
const REAL_TMPDIR = process.env.TMUX_TMPDIR;

let restore: typeof import("../src/tmuxrestore.ts");
let pane: typeof import("../src/tmuxpane.ts");
const S = `agxargv${process.pid}`;

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  restore = await import("../src/tmuxrestore.ts");
  pane = await import("../src/tmuxpane.ts");
});

afterAll(async () => {
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  for (const d of [TMPDIR, process.env.AGENTGLASS_STATE_DIR!]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* never made */ }
  }
});

const paneArgv = async (session: string, win: string): Promise<string[]> => {
  const pid = (await pane.tmux(["display-message", "-p", "-t", `=${session}:${win}`, "#{pane_pid}"])).stdout.trim();
  return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
};
/* After a beat: a pane forked a moment ago has not exec'd yet and reads as
   the tmux binary itself, which the capture leaves out on purpose. */
const photographed = async (win: string) => {
  await Bun.sleep(250);
  return (await restore.captureLayout())?.sessions.find((s) => s.name === S)?.windows.find((w) => w.name === win)?.panes[0];
};

describe("the photograph", () => {
  test("a window born from one string is its shell and that string, not a quoted line", async () => {
    const mk = await pane.tmux(["new-session", "-d", "-s", S, "-n", "one", "-x", "120", "-y", "30", "sleep 45 && echo 'a b' \"$HOME\""]);
    expect(mk.ok, mk.stderr).toBe(true);
    const got = await photographed("one");
    expect(got?.startArgv?.slice(1)).toEqual(["-c", "sleep 45 && echo 'a b' \"$HOME\""]);
    /* The string tmux reports, kept for old readers, is the quoted one. */
    expect(got?.startCommand.startsWith('"')).toBe(true);
  }, 20_000);

  test("a window born from several arguments is those arguments, spaces and all", async () => {
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "many", "sleep", "45", "x y"]);
    await Bun.sleep(100);
    /* `sleep` refuses a second operand and dies; the engine's default keeps
       nothing, so this window is gone. Its living twin: */
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "many2", "sh", "-c", "exec sleep 45 # x y"]);
    const got = await photographed("many2");
    expect(got?.startArgv, "exec replaced the shell: the process is what runs").toEqual(["sleep", "45"]);
  }, 20_000);

  test("a plain shell is nothing to bring back: tmux gives a restored pane one anyway", async () => {
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "shell"]);
    const got = await photographed("shell");
    expect(got?.startArgv).toBeUndefined();
    expect(got?.startCommand).toBe("");
  }, 20_000);
});

describe("the restore", () => {
  test("runs the argv as it was, and a second photograph is the same argv — never one shell deeper", async () => {
    const before = await photographed("one");
    expect(before?.startArgv).toBeDefined();
    await pane.tmux(["kill-session", "-t", `=${S}`]);
    const r = await restore.restoreLayout("all");
    expect(r.ok, r.error).toBe(true);
    expect(await paneArgv(S, "one"), "the process in the restored pane runs the born-with argv").toEqual(before!.startArgv!);
    const after = await photographed("one");
    expect(after?.startArgv).toEqual(before!.startArgv!);
  }, 20_000);

  test("hands an argv to tmux as argv — the one `sh -c` left is for a photograph from before argv existed", () => {
    expect(restore.runArgs("all", { id: "%1", index: 0, active: true, command: "bash", path: "/tmp", startCommand: '"sleep 45"', startArgv: ["bash", "-c", "sleep 45"] }))
      .toEqual(["bash", "-c", "sleep 45"]);
    expect(restore.runArgs("all", { id: "%1", index: 0, active: true, command: "bash", path: "/tmp", startCommand: "sleep 45" }))
      .toEqual(["sh", "-c", "sleep 45"]);
    expect(restore.runArgs("lazy", { id: "%1", index: 0, active: true, command: "bash", path: "/tmp", startCommand: "sleep 45", startArgv: ["sleep", "45"] }))
      .toEqual([]);
  });
});
