/**
 * A pane photographed before it was born is not a window to bring back.
 *
 * tmux forks a new pane and sets its directory and command in the child, after
 * the `new-window` that asked for it has returned. Until the child execs it is
 * a copy of the tmux server: the server's argv, the server's cwd, `tmux` for a
 * command. A photograph taken in that moment, before the desk was whole, was
 * kept beside the right photograph that came next — windows are matched by
 * name and directory, and it had neither — so a crash restore built one window
 * more than the desk had, in the directory the app was started from.
 *
 * The moment lasts milliseconds, so the fixture holds it open: a pane whose
 * process wears the tmux server's command line (`perl`, `$0`) and stands in
 * the server's directory, which is what an unborn pane reads as. tmux is
 * reached through a wrapper of another name (`AGENTGLASS_TMUX_PATH`), so the
 * server is told by its argv and not by the wrapper's name.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readlinkSync, writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { settled } from "./paneSettled.ts";

const SOCK = `agx-unborn-${process.pid}`;
const ROOT = mkdtempSync(join(tmpdir(), "agxu-"));
const STATE = join(ROOT, "state");
const TMPDIR = join(ROOT, "t");
/** Where the app — and so the tmux server — was started. */
const APP = join(ROOT, "app");
const realTmux = Bun.which("tmux") || "/usr/bin/tmux";
const sock = ["-f", "/dev/null", "-L", SOCK];
const sh = (a: string[]) => Bun.spawnSync(["env", "-u", "TMUX", realTmux, ...sock, ...a], { cwd: APP, stdout: "pipe", stderr: "pipe", env: { ...process.env, TMUX_TMPDIR: TMPDIR } });
const out = (a: string[]) => sh(a).stdout.toString().trim();
const layoutFile = () => join(STATE, "tmux", "restore", "layout.json");
type Shot = { sessions: { name: string; windows: { name?: string; panes: { path: string }[] }[] }[] };
const desk = (): Shot["sessions"][number] | undefined =>
  existsSync(layoutFile()) ? (JSON.parse(readFileSync(layoutFile(), "utf8")) as Shot).sessions.find((s) => s.name === "desk") : undefined;

let restore: typeof import("../src/tmuxrestore.ts");
const saved = { ...process.env };

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  mkdirSync(APP, { recursive: true });
  const shim = join(ROOT, "tmux-wrapper");
  writeFileSync(shim, `#!/bin/sh\nexec "${realTmux}" "$@"\n`);
  chmodSync(shim, 0o755);
  process.env.TMUX_TMPDIR = TMPDIR;
  process.env.AGENTGLASS_TMUX_SOCKET = SOCK;
  process.env.AGENTGLASS_STATE_DIR = STATE;
  process.env.AGENTGLASS_TMUX_PATH = shim;
  delete process.env.TMUX;
  restore = await import("../src/tmuxrestore.ts");
  sh(["new-session", "-d", "-s", "desk", "-n", "w1", "-c", "/tmp", "sleep 600"]);
  await settled(() => out(["list-panes", "-t", "=desk", "-F", "#{pane_current_command} #{pane_current_path}"]), (r) => r === "sleep /tmp");
});

afterAll(() => {
  sh(["kill-server"]);
  for (const k of ["TMUX_TMPDIR", "AGENTGLASS_TMUX_SOCKET", "AGENTGLASS_STATE_DIR", "AGENTGLASS_TMUX_PATH"]) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  restore.__resetRestoreSettled();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* gone */ }
});

test("a window photographed before its pane was born is not brought back beside the real one", async () => {
  /* Before the desk is whole: the stretch where a window missing from a
     photograph is kept, which is the stretch the phantom lived in. */
  restore.__resetRestoreSettled();
  const server = out(["display-message", "-p", "#{pid}"]);
  const serverArgv = readFileSync(`/proc/${server}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
  const [pane = "", pid = ""] = out(["new-window", "-d", "-t", "=desk", "-c", APP, "-P", "-F", "#{pane_id} #{pane_pid}", `exec perl -e '$0 = shift; sleep 600' '${serverArgv}'`]).split(" ");
  /* Past the fork, the shell and perl's own start, into its `$0`: the real fork
     is the same picture for a moment too, so the photograph waits for the one
     that stays — perl's binary wearing the server's command line, and tmux
     reading it back as `tmux` in the server's directory. */
  const look = () => {
    let exe = "", argv = "";
    try { exe = readlinkSync(`/proc/${pid}/exe`).split("/").pop() || ""; argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "); } catch { /* not yet */ }
    return { perl: exe.startsWith("perl"), argv, pane: out(["display-message", "-p", "-t", pane, "#{pane_current_command} #{pane_current_path}"]) };
  };
  const held = await settled(look, (l) => l.perl && l.argv === serverArgv && l.pane === `tmux ${APP}`);
  expect(held).toEqual({ perl: true, argv: serverArgv, pane: `tmux ${APP}` });

  await restore.captureLayout();
  expect(desk()?.windows.some((w) => w.panes.some((p) => p.path === APP)) ?? false).toBe(false);

  /* Born: the same pane, now running its command in its own directory. */
  sh(["respawn-pane", "-k", "-t", pane, "-c", "/tmp", "sleep 600"]);
  sh(["rename-window", "-t", pane, "w2"]);
  const born = await settled(() => out(["display-message", "-p", "-t", pane, "#{window_name} #{pane_current_command} #{pane_current_path}"]), (r) => r === "w2 sleep /tmp");
  expect(born).toBe("w2 sleep /tmp");

  await restore.captureLayout();
  const windows = desk()?.windows ?? [];
  expect(windows.map((w) => `${w.name} ${w.panes.map((p) => p.path).join(",")}`).sort()).toEqual(["w1 /tmp", "w2 /tmp"]);
});

/*
 * The same phantom one step later: the pane is born, but tmux renames an
 * automatically named window on a later loop than the exec, and only once the
 * pane has done something — a detached `sleep` keeps `tmux` for a name
 * (measured: still `tmux` seconds after, on tmux 3.6 and 3.8; though not on
 * every run). Photographed under one name, then again under the name tmux
 * gave it, it was two windows in one directory. The lag is made certain here
 * by changing `automatic-rename-format`, which tmux applies on the same later
 * loop and not when the option is set (measured).
 */
test("a window tmux has not renamed yet is photographed under the name tmux will give it", async () => {
  restore.__resetRestoreSettled();
  sh(["new-session", "-d", "-s", "desk2", "-n", "w1", "-c", "/tmp", "sleep 600"]);
  const pane = out(["new-window", "-d", "-t", "=desk2", "-c", "/tmp", "-P", "-F", "#{pane_id}", "sleep 601"]);
  const born = await settled(() => out(["display-message", "-p", "-t", pane, "#{pane_current_command} #{pane_current_path}"]), (r) => r === "sleep /tmp");
  expect(born).toBe("sleep /tmp");
  sh(["set-option", "-w", "-t", pane, "automatic-rename-format", "later"]);
  const lagging = out(["display-message", "-p", "-t", pane, "#{window_name} #{automatic-rename}"]);
  expect(lagging).not.toStartWith("later ");
  expect(lagging).toEndWith(" 1");

  await restore.captureLayout();
  // What tmux does on its next loop, done by hand: the name follows the format.
  sh(["rename-window", "-t", pane, "later"]);
  await restore.captureLayout();
  const windows = (JSON.parse(readFileSync(layoutFile(), "utf8")) as Shot).sessions.find((s) => s.name === "desk2")?.windows ?? [];
  expect(windows.map((w) => `${w.name} ${w.panes.map((p) => p.path).join(",")}`).sort()).toEqual(["later /tmp", "w1 /tmp"]);
});
