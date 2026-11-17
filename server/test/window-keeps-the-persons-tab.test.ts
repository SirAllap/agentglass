/*
 * A window opened for an agent lands in the background; one a person opened is
 * the window they end up looking at.
 *
 * `new-window` without `-d` makes the new window the session's current one, and
 * every client attached to that session redraws onto it — the app's Terminal
 * panel is one of those clients. Both halves are asserted, because a test that
 * passed the first by opening nothing at all would be no guard at all.
 *
 * Against a real tmux on its own socket, with `-f /dev/null`: the claim is about
 * the state of a session, and only a session can answer it. The argv each path
 * builds is asserted separately, in observe-only mode, where nothing runs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetSlowTmux, newWindowRunning, reopenWindow, runAction, suppressedTmuxWrites, forgetSuppressedTmuxWrites,
  type TmuxTarget,
} from "../src/tmuxctl.ts";

const has = !!Bun.which("tmux");

let dir = "";
let sock = "";
let savedTmpdir: string | undefined;
let savedTmux: string | undefined;

const socketArgs = () => ["-f", "/dev/null", "-L", sock];
const cli = (...a: string[]) =>
  Bun.spawnSync(["tmux", ...socketArgs(), ...a], {
    env: { ...process.env, TMUX_TMPDIR: dir },
    stdout: "pipe", stderr: "pipe",
  });

/** The window a client attached right now would be drawing. */
const onScreen = () => {
  const rows = cli("list-windows", "-t", "=work", "-F", "#{window_name} #{window_active}").stdout.toString();
  const active = rows.split("\n").find((l) => l.trimEnd().endsWith(" 1")) ?? "";
  return active.trim().split(" ")[0] ?? "";
};

const target = (): TmuxTarget => ({
  pid: process.pid, socket: socketArgs(), session: "work",
  id: cli("display-message", "-p", "-t", "work", "#{session_id}").stdout.toString().trim(),
});

/** The `new-window` command one call built, as observe-only recorded it. */
const newWindowLine = async (run: () => unknown): Promise<string[]> => {
  forgetSuppressedTmuxWrites();
  await run();
  return suppressedTmuxWrites().find((c) => c.includes("new-window")) ?? [];
};

beforeAll(() => {
  savedTmpdir = process.env.TMUX_TMPDIR;
  savedTmux = process.env.TMUX;
  if (!has) return;
  dir = mkdtempSync(join(tmpdir(), "agx-nofocus-"));
  sock = `agx-nofocus-${process.getuid?.() ?? 0}-${process.pid}`;
  process.env.TMUX_TMPDIR = dir;
  delete process.env.TMUX;
});

beforeEach(() => {
  /* One slow tmux call (a loaded full run) skips reads on this socket for 3 s;
     every test here starts a fresh server on the same socket name. */
  __resetSlowTmux();
  if (!has) return;
  cli("kill-server");
  cli("new-session", "-d", "-s", "work", "-n", "mine", "-c", "/tmp", "sleep", "300");
});

afterEach(() => {
  delete process.env.AGENTGLASS_TMUX_OBSERVE_ONLY;
  if (has) cli("kill-server");
});

afterAll(() => {
  if (has) {
    cli("kill-server");
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
  if (savedTmpdir === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = savedTmpdir;
  if (savedTmux === undefined) delete process.env.TMUX; else process.env.TMUX = savedTmux;
});

describe.if(has)("which window a new one leaves on screen", () => {
  test("an agent's window is opened behind the one being read", async () => {
    expect(onScreen()).toBe("mine");
    const made = newWindowRunning(target(), "/tmp", "agent-1042", ["sleep", "300"]);
    expect(made).not.toBeNull();
    expect(onScreen()).toBe("mine");
  });

  test("the strip's own + puts its window on screen", async () => {
    expect(await runAction(target(), "new", undefined, undefined, undefined, undefined, undefined, "/tmp")).toBe(true);
    expect(onScreen()).toMatch(/^AI\d\d$/);
  });

  test("Reopen puts the window it brought back on screen", async () => {
    expect(await reopenWindow(target(), "shell-again", "/tmp", undefined, true)).toBe(true);
    expect(onScreen()).toBe("shell-again");
  });
});

describe.if(has)("the new-window line each of them builds", () => {
  test("an agent's carries -d, so tmux does not select it", async () => {
    process.env.AGENTGLASS_TMUX_OBSERVE_ONLY = "1";
    const argv = await newWindowLine(() => newWindowRunning(target(), "/tmp", "agent-1043", ["sleep", "300"]));
    expect(argv).toContain("new-window");
    expect(argv).toContain("-d");
  });

  test("a person's does not, because they are waiting to see what it did", async () => {
    process.env.AGENTGLASS_TMUX_OBSERVE_ONLY = "1";
    const argv = await newWindowLine(() =>
      runAction(target(), "new", undefined, undefined, undefined, undefined, undefined, "/tmp"));
    expect(argv).toContain("new-window");
    expect(argv).not.toContain("-d");
  });
});
