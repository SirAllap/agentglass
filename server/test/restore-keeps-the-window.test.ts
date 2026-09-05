/*
 * A COMMAND THAT WILL NOT START MUST NOT COST THE WINDOW.
 *
 * The restore builds each window WITH its command inside it, and tmux closes a
 * window whose command has exited. Nothing here sets `remain-on-exit` and
 * nothing should: the understudy depends on a finished run's window closing
 * itself. So when `claude --resume <id>` cannot start — the conversation is
 * already open in another pane, the id is unknown to the CLI, the binary moved
 * — the window it was created in disappears in the same second, silently, and
 * the count still says it was restored.
 *
 * Measured on the owner's machine after a reboot on 2026-09-02: a session of five
 * windows came back with one. The four whose resume failed
 * were created and gone within the same second, `restored` said five, and he
 * rebuilt his desk by hand and told us it had not come back.
 *
 * Worse, and reproduced on an isolated server: when it is the session's FIRST
 * window, the session goes with it and tmux, left with no sessions, exits —
 * so every `new-window -t =session:` afterwards fails with "no server running"
 * and `restorePass` ignores each failure in turn.
 *
 * These tests run real tmux on their own socket, with a command that exits
 * immediately standing in for a CLI that will not start. They assert the desk,
 * not the conversation: a pane back as a shell in the right directory has lost
 * something one line recovers, a window that is not there has lost the tab.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCKET = `agx-keepwin-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const TMPDIR = join(tmpdir(), `agx-keepwin-tmp-${process.pid}`);
process.env.AGENTGLASS_STATE_DIR = join(tmpdir(), `agx-keepwin-state-${process.pid}`);
/* Short, because `exit 1` dies in about a millisecond. The default is two
   seconds, for a CLI that takes a few hundred to fail. */
process.env.AGENTGLASS_RESTORE_SETTLE_MS = "400";
const REAL_TMPDIR = process.env.TMUX_TMPDIR;

let restore: typeof import("../src/tmuxrestore.ts");
let pane: typeof import("../src/tmuxpane.ts");

const S = (n: string) => `agxkeep${process.pid}${n}`;
const DIES = "exit 1";
const LIVES = "sleep 45";

/** A layout on disk, written by hand: this is what a photograph of a desk
 *  looks like, and the only input `restoreLayout` has. */
function writeLayout(sessions: unknown[]): void {
  const dir = join(process.env.AGENTGLASS_STATE_DIR!, "tmux", "restore");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "layout.json"), JSON.stringify({ capturedAt: 1, sessions }));
}

const win = (name: string, startCommand: string, extra: string[] = []) => ({
  id: `@${name}`, name, panes: [
    { id: `%${name}`, index: 0, active: true, path: "/tmp", startCommand },
    ...extra.map((c, i) => ({ id: `%${name}x${i}`, index: i + 1, active: false, path: "/tmp", startCommand: c })),
  ],
});

async function windowsOf(session: string): Promise<string[]> {
  const r = await pane.tmux(["list-windows", "-t", `=${session}`, "-F", "#{window_name}"]);
  return r.ok ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  restore = await import("../src/tmuxrestore.ts");
  pane = await import("../src/tmuxpane.ts");
});

afterAll(async () => {
  /* Kill BEFORE the environment goes back, or the kill addresses the wrong
     server — the one this suite must never touch. */
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* never made */ }
  try { rmSync(process.env.AGENTGLASS_STATE_DIR!, { recursive: true, force: true }); } catch { /* never made */ }
});

describe("the desk comes back even when the commands do not", () => {
  test("a window whose command exits is still a window, as a shell", async () => {
    const name = S("a");
    writeLayout([{ name, windows: [win("keeps", LIVES), win("dies", DIES), win("alsodies", DIES)] }]);
    const r = await restore.restoreLayout("all");
    expect(r.ok).toBe(true);
    const back = await windowsOf(name);
    expect(back.sort(), `the desk came back as: ${back.join(", ")}`).toEqual(["alsodies", "dies", "keeps"]);
    /* And the count is the truth rather than the intention: three standing. */
    expect(r.restored).toBe(3);
  }, 20_000);

  test("even when it is the FIRST window, which takes the session and the server with it", async () => {
    const name = S("b");
    writeLayout([{ name, windows: [win("first", DIES), win("second", DIES), win("third", LIVES)] }]);
    const r = await restore.restoreLayout("all");
    expect(r.ok).toBe(true);
    const back = await windowsOf(name);
    expect(back.sort(), `the desk came back as: ${back.join(", ")}`).toEqual(["first", "second", "third"]);
  }, 20_000);

  test("a split whose command exits comes back as a split", async () => {
    const name = S("c");
    writeLayout([{ name, windows: [win("two", LIVES, [DIES])] }]);
    await restore.restoreLayout("all");
    const panes = await pane.tmux(["list-panes", "-t", `=${name}:`, "-F", "#{pane_id}"]);
    expect(panes.stdout.split("\n").filter((l) => l.trim()).length,
      "the second pane was lost with its command").toBe(2);
  }, 20_000);

  test("a live session is never touched, whatever the photograph says", async () => {
    /* The guarantee this whole file rests on: restore only ever BUILDS what is
       missing. The owner's working desk is not an input to it. */
    const name = S("d");
    await pane.tmux(["new-session", "-d", "-s", name, "-n", "mine", "-c", "/tmp"]);
    writeLayout([{ name, windows: [win("notmine", DIES), win("neither", DIES)] }]);
    await restore.restoreLayout("all");
    expect(await windowsOf(name), "the restore rebuilt a session that was alive").toEqual(["mine"]);
  }, 20_000);

  test("the flags a pane was started with reach the command that restores it", async () => {
    /* The other half of the desk: `runArgs` builds `[bin, ...flags, --resume,
       id]`, so a pane the owner started with `--dangerously-skip-permissions`
       comes back that way and one he did not does not acquire it. Read off the
       source because building it needs a real CLI on the PATH, which a suite
       must not depend on — see the note in restore-keeps-the-flags.test.ts. */
    const src = await Bun.file(new URL("../src/tmuxrestore.ts", import.meta.url)).text();
    const fn = src.slice(src.indexOf("function runArgs("), src.indexOf("\n}", src.indexOf("function runArgs(")));
    expect(fn).toContain("...(pane.agentArgs ?? [])");
    const flags = fn.indexOf("pane.agentArgs");
    const id = fn.indexOf('"--resume"');
    expect(flags, "the flags must go before the id, so nothing captured displaces it").toBeLessThan(id);
  });

  test("in lazy mode nothing is started, so nothing can have died", async () => {
    const name = S("e");
    writeLayout([{ name, windows: [win("one", DIES), win("two", DIES)] }]);
    const r = await restore.restoreLayout("lazy");
    expect(r.restored).toBe(2);
    expect((await windowsOf(name)).sort()).toEqual(["one", "two"]);
  }, 20_000);
});
