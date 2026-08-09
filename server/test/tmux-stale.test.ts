// Giving the status line back after a crash, which is the only case that was
// not covered.
//
// The panel borrows tmux's status row and rebinds two prefix keys while it owns
// them, and it gives both back when it closes. That release is keyed off state
// held in memory, so it runs on close and on shell exit — and not at all when
// the process is killed, OOMed, or goes down with the lid. What was left behind
// is somebody's tmux session with no status line and `prefix ,` writing notes
// nobody reads, healing only if they happened to reopen the panel on that exact
// session and then close it properly.
//
// This line used to read "Every test here runs against its own tmux server on a
// private socket", and it was wrong in the two ways that mattered. The socket
// NAME was private; the DIRECTORY and the CONFIGURATION were the developer's.
// `-L agx-stale-test` with no TMUX_TMPDIR lands in /tmp/tmux-<uid>, beside the
// `default` his sessions are on, and no `-f` means the server reads
// ~/.tmux.conf like any other.
//
// Not deduced — measured, by running the whole server suite behind a `tmux` that
// resolves the socket by tmux's own rule and records where each call lands. This
// file made 239 of the 333 calls that reached his socket directory, and the
// callers name what was really happening:
//
//   .tmux/plugins/tpm/tpm                          63 calls from kanagawa.sh
//   .tmux/plugins/tmux-resurrect/resurrect.tmux    tmux-yank, tmux-sensible, …
//   .tmux/plugins/tmux-continuum/continuum.tmux
//   .tmux/plugins/tmux-continuum/scripts/continuum_restore.sh   <- this one ran
//
// His plugin manager was not "inheritable", it was EXECUTING inside a fixture
// this file created and then `kill-server`s. `@continuum-restore 'on'` is in his
// config, and the only thing that stopped it rebuilding his workspace in here is
// continuum's own `another_tmux_server_running_on_startup` — literally "is
// another tmux of mine already up". On a fresh boot, on CI, or any evening his
// tmux is down, that check flips and this file starts the only server on the
// machine, with his config, with restore on, and with tmux-assistant-resurrect
// relaunching his agent CLIs `--resume` into it. That is not a new risk: it is
// the exact afternoon tmuxIsolated.ts was written about.
//
// So: `-f /dev/null` for the config and a TMUX_TMPDIR of our own for the
// directory. The socket NAME stays fixed and the DIRECTORY carries the pid,
// which is the shape ce905fa measured — isolating the name instead makes it
// worse (18 failures against 5), because the search hands every server in a
// directory to `listPanes`.
//
// The assertions below read `list-keys` and `show-options`, so until now they
// were measuring his dotfiles and passing by luck. Under `-f /dev/null` they
// measure tmux's own defaults, which is what they were always claiming to.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";

// Short, for the 108-byte unix socket path limit.
const TMPDIR = `/tmp/agx-tmux-stale-${process.pid}`;
const SOCK = [...TMUX_ISOLATED, "-L", "agx-stale-test"];
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const has = !!Bun.which("tmux");

/** `env: process.env` and it is load-bearing, not decoration: measured on Bun
 *  1.3.9, a `Bun.spawnSync` with no `env` gets the environment as it was when
 *  the PROCESS started, not `process.env` as it is now. Without it the
 *  TMUX_TMPDIR set in `beforeAll` reaches `tmuxctl.ts` (which passes
 *  `process.env`) and not this helper — so the code under test would look in
 *  our directory while the fixture built its server in his. */
const raw = (args: string[]) =>
  Bun.spawnSync(["tmux", ...SOCK, ...args], { stdout: "pipe", stderr: "pipe", timeout: 5000, env: process.env });
const out = (args: string[]) => raw(args).stdout.toString().trim();

let ctl: typeof import("../src/tmuxctl.ts");
let mine = "";
let theirs = "";

beforeAll(async () => {
  if (!has) return;
  // Set here and put back in afterAll rather than at module load: `bun test`
  // runs a suite's files in one process, and the other tmux files are entitled
  // to the environment they were written against.
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  raw(["kill-server"]);
  raw(["new-session", "-d", "-s", "mine"]);
  raw(["new-session", "-d", "-s", "theirs"]);
  mine = out(["display-message", "-p", "-t", "mine", "#{session_id}"]);
  theirs = out(["display-message", "-p", "-t", "theirs", "#{session_id}"]);
  ctl = await import("../src/tmuxctl.ts");
});

afterAll(() => {
  if (has) raw(["kill-server"]);
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  // The directory carries a pid, so it is a new one every run and nobody would
  // ever reap it. A crashed run leaves an empty directory behind, which is the
  // honest trade for not colliding with the run next door.
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* already gone */ }
});

const target = () => ({ pid: 0, socket: SOCK, session: "mine", id: mine });
const opt = (sess: string, name: string) => out(["show-options", "-qv", "-t", sess, name]);
const client = () => ({ pid: 0, socket: SOCK, tty: "/dev/null" });
/** The whole table, then the key — never `list-keys -T prefix ,`. See the note
 *  on the same helper in tmux-bar.test.ts: the one-key form answers on the
 *  attached client's screen rather than on stdout. */
const keyLine = (key: string) => out(["list-keys", "-T", "prefix"]).split("\n")
  .find((l) => ctl.parseBinding(l)?.key === key) ?? "";

describe.if(has)("a run that was killed does not leave tmux broken", () => {
  test("the takeover is what a crash would leave behind", () => {
    const before = keyLine(",");
    expect(ctl.setStatusLine(target(), false)).toBe(true);
    // This is the state a SIGKILL freezes: the row kept and blanked (tmux needs
    // somewhere to draw a message that is not the pane), the claim still set,
    // and the way back written on the session rather than in a variable.
    expect(out(["show-options", "-t", mine, "-v", "status"])).toBe("on");
    expect(out(["show-options", "-t", mine, "-v", "status-format[0]"])).toBe("");
    expect(opt(mine, "@agx-owned")).toBe("1");
    expect(opt(mine, "@agx-had-rename")).toContain("bind-key");
    expect(before).toContain("command-prompt");
  });

  test("the next run gives it back, without having been told what it took", () => {
    // No in-memory state is handed over — releaseStale is given only a client,
    // exactly as a fresh process would have it.
    ctl.releaseStale(client());
    expect(out(["show-options", "-t", mine, "-v", "status"])).toBe("");
    expect(opt(mine, "@agx-owned")).toBe("");
    const back = keyLine(",");
    expect(back).not.toContain("@agx-ask");
    // Restored verbatim, quoting intact — the saved line is re-run through
    // tmux's own parser rather than rebuilt from an argv.
    expect(back).toContain('command-prompt -I "#W"');
  });

  test("it sweeps once per server, so it cannot fight a live panel", () => {
    // Second call on the same socket must be a no-op: by then this process may
    // legitimately own a session, and a sweep that ran again would release a
    // status line out from under a panel that is still using it.
    ctl.setStatusLine(target(), false);
    expect(opt(mine, "@agx-owned")).toBe("1");
    ctl.releaseStale(client());
    expect(opt(mine, "@agx-owned")).toBe("1");
    ctl.setStatusLine(target(), true);
  });

  test("a session the panel never touched is not touched by the sweep either", () => {
    expect(opt(theirs, "@agx-owned")).toBe("");
    // `status` unset means "whatever your config says" — the sweep must not
    // turn it on, because forcing a value is its own kind of override.
    expect(out(["show-options", "-t", theirs, "-v", "status"])).toBe("");
  });
});
