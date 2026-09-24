/*
 * A TAB WHOSE PROGRAM DIED IS STILL A TAB.
 *
 * tmux closes a window the instant its command exits — `remain-on-exit` is
 * off by default — and the engine's own config left it that way. For a
 * program that CRASHED that is a tab gone from the strip in the same second,
 * with nothing anywhere to say why. Measured on the owner's desk on
 * 2026-09-21: five tabs running agent CLIs, each started by hand with
 * `tmux new-window "cli …"` and so without the wrapper this app's own windows
 * carry to hold the pane open, vanished over one afternoon. The only trace of
 * any of them was a pane id in a note; the app itself had killed none of them.
 *
 * So the engine's config now keeps a pane whose command FAILED — a non-zero
 * status or a signal — dead, with tmux's own line ("Pane is dead (status 3,
 * …)") where the program was, and still closes a tab whose program ended on
 * purpose. Three things follow from that and are pinned here:
 *
 *   - a window this app opened for a run still closes itself whatever the
 *     status, because the run loop reads the window's absence as the run's
 *     end (panelease.ts);
 *   - a dead pane is not a running agent (agentops.ts);
 *   - a restore that could not bring a command back leaves a shell in the
 *     pane, not a corpse, and photographs a corpse as a shell so the next boot
 *     does not run the failure again (tmuxrestore.ts).
 *
 * Real tmux, on its own socket, with the engine's generated config — the
 * thing under test — written to a scratch state directory.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCKET = `agx-tabdies-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const TMPDIR = join(tmpdir(), `agx-tabdies-tmp-${process.pid}`);
process.env.AGENTGLASS_STATE_DIR = join(tmpdir(), `agx-tabdies-state-${process.pid}`);
process.env.AGENTGLASS_RESTORE_SETTLE_MS = "400";
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const REAL_XDG = process.env.XDG_CONFIG_HOME;
const REAL_STATE = process.env.AGENTGLASS_STATE_DIR;
process.env.XDG_CONFIG_HOME = join(tmpdir(), `agx-tabdies-home-${process.pid}`);

let conf: typeof import("../src/tmuxconf.ts");
let pane: typeof import("../src/tmuxpane.ts");
let lease: typeof import("../src/panelease.ts");
let restore: typeof import("../src/tmuxrestore.ts");
let ops: typeof import("../src/agentops.ts");

const S = `agxdies${process.pid}`;

async function windowsOf(session: string): Promise<string[]> {
  const r = await pane.tmux(["list-windows", "-t", `=${session}`, "-F", "#{window_name}"]);
  return r.ok ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort() : [];
}
const show = async (target: string, format: string) =>
  (await pane.tmux(["display-message", "-p", "-t", target, format])).stdout.trim();
/* A login shell takes its time to come up under a full suite, and tmux takes
   a beat to act on its exit: poll, never a fixed sleep. */
async function until(cond: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await Bun.sleep(150); }
  return cond();
}
/** Type `exit 1` at a shell once it is at its prompt, and wait for tmux to act. */
async function exitShell(target: string, shell: RegExp): Promise<void> {
  expect(await until(async () => shell.test(await show(target, "#{pane_current_command}")))).toBe(true);
  await Bun.sleep(300);
  await pane.tmux(["send-keys", "-t", target, "exit 1", "Enter"]);
}

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  mkdirSync(process.env.XDG_CONFIG_HOME!, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  conf = await import("../src/tmuxconf.ts");
  pane = await import("../src/tmuxpane.ts");
  lease = await import("../src/panelease.ts");
  restore = await import("../src/tmuxrestore.ts");
  ops = await import("../src/agentops.ts");
  /* The engine's config is what is under test; `tmux()` passes its path on
     every call, so it has to exist before the first call. Written by hand
     rather than through `ensureConf()`: that one remembers the CONTENT it last
     wrote, and every test file shares one process — a suite that wrote the
     same text to its own scratch directory earlier would make it a no-op
     here, and this server would boot with no config at all. */
  mkdirSync(dirname(conf.confPath()), { recursive: true });
  writeFileSync(conf.confPath(), conf.confContent());
  lease.__resetLeases();
});

afterAll(async () => {
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = REAL_XDG;
  for (const d of [TMPDIR, process.env.AGENTGLASS_STATE_DIR!, join(tmpdir(), `agx-tabdies-home-${process.pid}`)]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* never made */ }
  }
  /* Every test file shares one process: a state dir left pointing at a
     directory this file has just deleted is the next file's problem. */
  if (REAL_STATE === undefined) delete process.env.AGENTGLASS_STATE_DIR;
  else process.env.AGENTGLASS_STATE_DIR = REAL_STATE;
});

describe("a tab on the engine", () => {
  test("stays when its program fails, with the status on it, and closes when the program ends cleanly", async () => {
    const mk = await pane.tmux(["new-session", "-d", "-s", S, "-n", "keeps", "-x", "120", "-y", "30", "sleep", "45"]);
    expect(mk.ok, mk.stderr).toBe(true);
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "crashed", "sh", "-c", "exit 3"]);
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "clean", "sh", "-c", "exit 0"]);
    await Bun.sleep(400);
    expect(await windowsOf(S), "the failed program's tab is the one that must still be there").toEqual(["crashed", "keeps"]);
    expect(await show(`=${S}:crashed`, "#{pane_dead} #{pane_dead_status}")).toBe("1 3");
  }, 20_000);

  test("a plain shell that exits with a status closes as it always did", async () => {
    /* An interactive shell exits with the status of its last command, so
       `false` then Ctrl-D would otherwise leave every Terminal tab a corpse
       (measured). A pane born with no command is the shell's own tab: the
       engine turns the option off on it at birth, and its pane-died hook
       closes it if it was kept anyway. */
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", "shell"]);
    await exitShell(`=${S}:shell`, /^(bash|fish|zsh|sh|dash|ksh)$/);
    expect(await until(async () => !(await windowsOf(S)).includes("shell")), "the shell's own tab is not a program that failed").toBe(true);
  }, 20_000);

  test("a dead pane is photographed as a shell, never as the command that failed", async () => {
    const state = await restore.captureLayout();
    const sess = state?.sessions.find((s) => s.name === S);
    const crashed = sess?.windows.find((w) => w.name === "crashed")?.panes[0];
    expect(crashed, "the window is still there, so it is in the picture").toBeDefined();
    expect(crashed!.startCommand).toBe("");
    expect(crashed!.agentSession).toBeUndefined();
  }, 20_000);

  test("a dead pane is not a running agent", async () => {
    const dead = await show(`=${S}:crashed`, "#{pane_id}");
    const live = await show(`=${S}:keeps`, "#{pane_id}");
    expect(await ops.paneAlive(live)).toBe(true);
    expect(await ops.paneAlive(dead), "a corpse would otherwise be listed, prompted and waited on").toBe(false);
  }, 20_000);

  test("a window this app leased for a run still closes itself, whatever the status", async () => {
    const r = await pane.tmux(["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `=${S}:`, "-n", "run", "sh", "-c", "sleep 0.6; exit 3"]);
    const wid = r.stdout.trim();
    expect(wid).toMatch(/^@\d+$/);
    expect(await lease.takeLease(wid, "understudy: orbit-1042")).not.toBeNull();
    await Bun.sleep(1400);
    expect(await windowsOf(S), "the run loop reads this window's absence as the run's end").not.toContain("run");
    expect(await lease.leaseHeld(wid)).toBe(false);
  }, 20_000);
});

describe("a restore on that engine", () => {
  function writeLayout(sessions: unknown[]): void {
    const dir = join(process.env.AGENTGLASS_STATE_DIR!, "tmux", "restore");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "layout.json"), JSON.stringify({ capturedAt: 1, sessions }));
  }
  const win = (name: string, startCommand: string) => ({
    id: `@${name}`, name, panes: [{ id: `%${name}`, index: 0, active: true, path: "/tmp", startCommand }],
  });

  test("a command that will not start leaves a shell in its window, not a corpse", async () => {
    const name = `${S}r`;
    writeLayout([{ name, windows: [win("dies", "exit 1"), win("keeps", "sleep 45")] }]);
    const r = await restore.restoreLayout("all");
    expect(r.ok).toBe(true);
    expect(await windowsOf(name)).toEqual(["dies", "keeps"]);
    expect(await show(`=${name}:dies`, "#{pane_dead}"), "a restored desk is somewhere to type, not a status line").toBe("0");
    /* And that shell closes on exit like a plain tab, although its pane was
       born with a command: the pane option was put back to off. */
    await exitShell(`=${name}:dies`, /^(bash|fish|zsh|sh|dash|ksh)$/);
    expect(await until(async () => !(await windowsOf(name)).includes("dies"))).toBe(true);
    expect(await windowsOf(name)).toEqual(["keeps"]);
  }, 20_000);
});
