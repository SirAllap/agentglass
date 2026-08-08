/*
 * A window pinned for a phone that is gone puts itself back.
 *
 * THE STATE THIS EXISTS TO END, found on a real machine: window `@64` at
 * `window-size manual`, 80 columns wide, inside a 285-column terminal, with no
 * phone attached to it and no mark on it — hours after the phone had left. The
 * desk showed a notice explaining it and a button to fix it, which is a job
 * with no decision in it being handed to a person.
 *
 * There are two halves and this file measures both against a real tmux, because
 * neither can be reasoned about:
 *
 *   `fitWindow` writes the durable mark. It did not, and that is how the window
 *   above came to be unattributable: the mark is written at ATTACH, the teardown
 *   clears it when it restores, and a fit arriving after that restore pinned the
 *   window again with nothing left on it to say who by.
 *
 *   `reclaimPinnedWindow` puts such a window back, but only after it has been
 *   free for a moment (a phone switching tabs is briefly gone) and only when the
 *   mark proves the size was ours to take (a window somebody narrowed themselves
 *   is not ours to widen).
 *
 * Its own tmux server, its own TMUX_TMPDIR, `-f /dev/null`: this machine's
 * config loads tmux-continuum, which restores the user's real sessions into any
 * server that starts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { TEST_TERM } from "./tmuxTerm.ts";

/** Short, for the 108-byte unix socket path limit. The DIRECTORY carries the
 *  pid and the socket NAME stays fixed — see tmux-attach-claim.test.ts for the
 *  measurements behind that split. */
const TMPDIR = `/tmp/agx-tmux-rec-${process.pid}`;
const SOCK = "agx-rec";
const OURS = ["-L", SOCK];
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const HAVE_TMUX = !!Bun.which("tmux") && !!Bun.which("python3") && process.platform === "linux";

const clientEnv = (): Record<string, string> => ({ ...process.env, TERM: TEST_TERM } as Record<string, string>);

const tmux = (...args: string[]): string =>
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", SOCK, ...args], { stdout: "pipe", stderr: "pipe", env: process.env })
    .stdout.toString().trim();

const killServer = (): void => {
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", SOCK, "kill-server"], { stdout: "ignore", stderr: "ignore", env: process.env });
};

/** A tmux client on a pty of an exact size, the way a terminal emulator makes
 *  one. `resize-window -A` means "the largest client viewing this window", so
 *  the restore has nothing to compute without a real client of a real size. */
function deskClient(cols: number, rows: number, target: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    ["python3", "-c",
      "import os,pty,fcntl,struct,termios,sys,time\n" +
      "pid,fd=pty.fork()\n" +
      "if pid==0: os.execvp('tmux',['tmux','-f','/dev/null','-L',sys.argv[1],'attach','-t',sys.argv[2]])\n" +
      "fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',int(sys.argv[4]),int(sys.argv[3]),0,0))\n" +
      "time.sleep(600)\n",
      SOCK, target, String(cols), String(rows)],
    { stdout: "ignore", stderr: "ignore", env: clientEnv() },
  );
}

const opt = (name: string, w: string): string => tmux("show-options", "-qwv", "-t", w, name);
const mark = (w: string): string => opt("@agx-had-size", w);
const sizeOpt = (w: string): string => opt("window-size", w);
const cols = (w: string): number => Number(tmux("display-message", "-p", "-t", w, "#{window_width}"));

/** The wait `reclaimPinnedWindow` insists on, plus enough to be past it. Kept
 *  as a number here rather than imported: the test is asserting that the wait
 *  is real, and reading it from the code under test would assert nothing. */
const PAST_THE_WAIT = 2200;

let ctl: typeof import("../src/tmuxctl.ts");
let desk: ReturnType<typeof Bun.spawn> | null = null;
let sessionId = "", pinned = "", theirs = "";

beforeAll(async () => {
  if (!HAVE_TMUX) return;
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  killServer();

  tmux("new-session", "-d", "-s", "desk", "-x", "200", "-y", "50", "sh", "-c", "exec sh");
  // `-d`, so the client stays on the first window: the second one is for the
  // window this app must NOT touch, and it must not be the one being drawn.
  tmux("new-window", "-d", "-t", "desk", "sh", "-c", "exec sh");
  await Bun.sleep(300);
  desk = deskClient(200, 50, "desk");
  await Bun.sleep(1000);

  sessionId = tmux("display-message", "-p", "-t", "desk", "#{session_id}");
  const windows = tmux("list-windows", "-t", "desk", "-F", "#{window_id}").split("\n");
  pinned = windows[0] ?? "";
  theirs = windows[1] ?? "";
  ctl = await import("../src/tmuxctl.ts");
}, 60_000);

afterAll(() => {
  try { desk?.kill(); } catch { /* already gone */ }
  if (HAVE_TMUX) killServer();
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* nothing there */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
});

describe.if(HAVE_TMUX)("a window a phone left pinned", () => {
  test("a fit records what the window had before it", () => {
    // The state every window starts in: no size of its own, and nothing of ours
    // on it. This is what the restore has to be able to put back.
    expect(sizeOpt(pinned)).toBe("");
    expect(mark(pinned)).toBe("");

    expect(ctl.fitWindow(OURS, sessionId, pinned, 60, 20)).toBe(true);
    expect(cols(pinned)).toBe(60);
    // tmux's own word for "somebody named a size and I am holding it" —
    // `resize-window` writes it whether or not anybody meant to.
    expect(sizeOpt(pinned)).toBe("manual");
    // `none` is the mark for "it carried no option of its own", which is a
    // different instruction from any of tmux's four values: put nothing back.
    expect(mark(pinned)).toBe("none");
  });

  test("a second fit does not overwrite what the first one saw", () => {
    // The window is `manual` now. A mark taken again here would record THAT,
    // and the restore would faithfully put the squeeze back.
    expect(ctl.fitWindow(OURS, sessionId, pinned, 70, 22)).toBe(true);
    expect(cols(pinned)).toBe(70);
    expect(mark(pinned)).toBe("none");
  });

  test("is not reclaimed the instant it looks free", () => {
    // A phone switching tabs closes one socket and opens the next, and between
    // them the window is pinned with nothing on it. Acting there gives the desk
    // its width and takes it away again — two reflows to arrive back where it
    // started.
    expect(ctl.reclaimPinnedWindow(OURS, sessionId, pinned, true)).toBe(false);
    expect(cols(pinned)).toBe(70);
  });

  test("a phone coming back resets the wait rather than shortening it", async () => {
    await Bun.sleep(PAST_THE_WAIT);
    // `false` is "a phone is on it": the window is owed to that phone's own
    // teardown, and the clock starts again when it goes.
    expect(ctl.reclaimPinnedWindow(OURS, sessionId, pinned, false)).toBe(false);
    expect(ctl.reclaimPinnedWindow(OURS, sessionId, pinned, true)).toBe(false);
    expect(cols(pinned)).toBe(70);
  });

  test("and puts itself back once it has really been left", async () => {
    await Bun.sleep(PAST_THE_WAIT);
    expect(ctl.reclaimPinnedWindow(OURS, sessionId, pinned, true)).toBe(true);
    // The desk's own client is the largest thing viewing it, which is the whole
    // of what `-A` computes.
    expect(cols(pinned)).toBe(200);
    // Put back to carrying no option of its own, which is what `none` meant.
    expect(sizeOpt(pinned)).toBe("");
    // And the record comes off, so nothing comes back for this window again.
    expect(mark(pinned)).toBe("");
  });

  test("a window narrowed by somebody else is left exactly as it is", async () => {
    // No mark: this app has no evidence the size is its to give back, and a
    // window somebody sized themselves is not a bug to be fixed. This is the
    // same proof the boot sweep insists on, asked at a different moment.
    tmux("resize-window", "-t", `${sessionId}:${theirs}`, "-x", "60", "-y", "20");
    expect(cols(theirs)).toBe(60);
    expect(mark(theirs)).toBe("");

    expect(ctl.reclaimPinnedWindow(OURS, sessionId, theirs, true)).toBe(false);
    await Bun.sleep(PAST_THE_WAIT);
    expect(ctl.reclaimPinnedWindow(OURS, sessionId, theirs, true)).toBe(false);
    expect(cols(theirs)).toBe(60);
    expect(sizeOpt(theirs)).toBe("manual");
  }, 15_000);
});
