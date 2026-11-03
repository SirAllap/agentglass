/*
 * "Reopen" after a close and "Restart here" on a dead pane, on a real tmux
 * with a socket of its own.
 *
 * Reopen puts a plain shell back next to the window that stood beside the
 * closed one, in its folder, under its name, selected. Restart respawns only a
 * pane that is dead: a live pane must never be killed by it.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { settled } from "./paneSettled.ts";

const SOCKET = `agx-reopen-${process.pid}`;
const TMPDIR = join(tmpdir(), `agx-reopen-tmp-${process.pid}`);
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const have = !!Bun.which("tmux");
const S = `agxreopen${process.pid}`;
const sock = ["-L", SOCKET, ...TMUX_ISOLATED];
const tmuxRun = (...a: string[]) => Bun.spawnSync(["tmux", ...sock, ...a], { env: { ...process.env, TMUX_TMPDIR: TMPDIR }, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
let ctl: typeof import("../src/tmuxctl.ts");
let target: import("../src/tmuxctl.ts").TmuxTarget;

beforeAll(async () => {
  if (!have) return;
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  ctl = await import("../src/tmuxctl.ts");
  tmuxRun("new-session", "-d", "-s", S, "-n", "one", "sleep", "300");
  tmuxRun("new-window", "-t", S, "-n", "two", "-c", tmpdir(), "sleep", "300");
  tmuxRun("new-window", "-t", S, "-n", "three", "sleep", "300");
  tmuxRun("set-option", "-g", "remain-on-exit", "failed");
  target = { pid: 0, socket: sock, session: S, id: tmuxRun("display-message", "-p", "-t", S, "#{session_id}") };
});

afterAll(() => {
  if (have) tmuxRun("kill-server");
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  rmSync(TMPDIR, { recursive: true, force: true });
});

const names = () => tmuxRun("list-windows", "-t", S, "-F", "#{window_name}").split("\n").join(",");

test.skipIf(!have)("a reopened window lands after the one that was before it, in its folder, named and selected", () => {
  const two = tmuxRun("list-windows", "-t", S, "-F", "#{window_id} #{window_name}").split("\n").find((l) => l.endsWith(" two"))!.split(" ")[0]!;
  tmuxRun("kill-window", "-t", two);
  expect(names()).toBe("one,three");
  const one = tmuxRun("list-windows", "-t", S, "-F", "#{window_id} #{window_name}").split("\n").find((l) => l.endsWith(" one"))!.split(" ")[0]!;
  expect(ctl.reopenWindow(target, "two", tmpdir(), one, true)).toBe(true);
  expect(names()).toBe("one,two,three");
  expect(tmuxRun("display-message", "-p", "-t", S, "#{window_name}")).toBe("two");
  expect(tmuxRun("display-message", "-p", "-t", S, "#{pane_current_path}")).toBe(tmpdir());
});

test.skipIf(!have)("Restart here respawns a dead pane as a shell in its folder and leaves a live pane alone", async () => {
  tmuxRun("new-window", "-t", S, "-n", "boom", "-c", tmpdir(), "sh", "-c", "exit 3");
  const boom = tmuxRun("list-windows", "-t", S, "-F", "#{window_id} #{window_name}").split("\n").find((l) => l.endsWith(" boom"))!.split(" ")[0]!;
  for (let i = 0; i < 100 && tmuxRun("display-message", "-p", "-t", boom, "#{pane_dead}") !== "1"; i++) await Bun.sleep(20);
  expect(tmuxRun("display-message", "-p", "-t", boom, "#{pane_dead}")).toBe("1");
  expect(ctl.restartWindow(target, boom)).toBe(true);
  expect(tmuxRun("display-message", "-p", "-t", boom, "#{pane_dead}")).toBe("0");
  // The respawned shell's directory is set by tmux's child after restartWindow returns (paneSettled.ts).
  expect(await settled(() => tmuxRun("display-message", "-p", "-t", boom, "#{pane_current_path}"), (p) => p === tmpdir())).toBe(tmpdir());
  // Alive now: a second press must not kill the shell it just started.
  const pid = tmuxRun("display-message", "-p", "-t", boom, "#{pane_pid}");
  expect(ctl.restartWindow(target, boom)).toBe(false);
  expect(tmuxRun("display-message", "-p", "-t", boom, "#{pane_pid}")).toBe(pid);
});
