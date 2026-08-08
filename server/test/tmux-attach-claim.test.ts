/*
 * A mark that is still being taken is not a mark that was abandoned.
 *
 * `sweepPinnedWindows` acts on `@agx-had-size` and justifies it with "stale by
 * definition": at boot, no phone in THIS process has attached to anything, so
 * every mark it can see belongs to a run that is gone. That is true of every
 * instant except one. `windowSizeOptions` writes the mark BEFORE its caller
 * spawns the attach argv, and the phone's `agx-phone-…` session — the only
 * thing `phoneWindows()` can see — does not exist until that spawn lands. For
 * the length of one spawn the window is marked and unprotected.
 *
 * MEASURED on a private server with the argv held back, before the fix:
 *
 *   after attachArgvFor    mark=none   sessions=desk   phoneWindows=[]
 *   a second server boots  restored=0
 *   after that sweep       mark=(gone)
 *
 * `restored=0`: nothing moved, nothing looked wrong, no test went red. But the
 * durable record was gone, and the fit a millisecond later pinned that window
 * with nothing on it to say who by — so a SIGKILL after that leaves it `manual`
 * for the life of the tmux server, which is the exact bug the feature exists to
 * fix. He runs about ten of these servers, so two booting at once is a Tuesday.
 *
 * The fix is `@agx-had-size-by`: the pid that took the mark, and that process's
 * start time so a reused pid cannot inherit the claim. Both halves are asserted
 * here, because a claim that is never released is worse than no claim at all —
 * it would strand exactly the windows the sweep is for.
 *
 * Its own tmux server, its own TMUX_TMPDIR, `-f /dev/null`: this machine's
 * config loads tmux-continuum, which restores the user's real sessions into any
 * server that starts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/*
 * Short, for the 108-byte unix socket path limit — a pid is five or six of
 * those bytes.
 *
 * The DIRECTORY carries the pid, the socket NAME stays fixed, and both halves
 * were measured on the sibling file in ce905fa. A shared directory AND a shared
 * name is a shared SERVER, so each run's `killServer` in `beforeAll` tore down
 * the other's fixture mid-assertion — several sessions work in this repository
 * at once and two `bun test` runs overlap constantly, costing 3-8 tests apiece
 * where one copy alone loses none. Isolating the NAME instead went from 5
 * failures to 18: `tmuxSockets` hands every server in a directory to
 * `listPanes`, so each run saw the other's panes and the ambiguity guard
 * refused them all — correctly.
 *
 * The fixed directory used to mean a crashed run left one server for the next
 * run to reap. `afterAll` already removes the whole directory, so what a crash
 * leaves now is one empty directory rather than a live server.
 */
const TMPDIR = `/tmp/agx-tmux-claim-${process.pid}`;
const SOCK = "agx-claim";
const CTL = new URL("../src/tmuxctl.ts", import.meta.url).pathname;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const HAVE_TMUX = !!Bun.which("tmux") && !!Bun.which("python3") && process.platform === "linux";

/** `env: process.env` on every spawn: measured on Bun 1.3.9, a `Bun.spawnSync`
 *  with no `env` gets the environment as it was when the PROCESS started, so
 *  the TMUX_TMPDIR set in `beforeAll` would reach the code under test and not
 *  this helper. */
const tmux = (...args: string[]): string =>
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", SOCK, ...args], { stdout: "pipe", stderr: "pipe", env: process.env })
    .stdout.toString().trim();

const killServer = (): void => {
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", SOCK, "kill-server"], { stdout: "ignore", stderr: "ignore", env: process.env });
};

/** A tmux client on a pty of an exact size, the way a terminal emulator makes
 *  one — a precondition and not scenery: `listPanes` reports only servers
 *  somebody is attached to, so `attachArgvFor` finds nothing without it. */
function deskClient(cols: number, rows: number, target: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    ["python3", "-c",
      "import os,pty,fcntl,struct,termios,sys,time\n" +
      "pid,fd=pty.fork()\n" +
      "if pid==0: os.execvp('tmux',['tmux','-f','/dev/null','-L',sys.argv[1],'attach','-t',sys.argv[2]])\n" +
      "fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',int(sys.argv[4]),int(sys.argv[3]),0,0))\n" +
      "time.sleep(600)\n",
      SOCK, target, String(cols), String(rows)],
    { stdout: "ignore", stderr: "ignore", env: process.env },
  );
}

/**
 * A SECOND agentglass server booting, which is the whole scenario.
 *
 * A separate process and not another call in this one, because `sizeSwept`
 * makes the sweep once-per-server-per-process: a second call here would return
 * without looking at anything and the test would pass having done nothing.
 * NODE_ENV is cleared so this child is a genuine boot rather than a test — the
 * isolation guard in `tmuxctl.ts` would otherwise refuse it, correctly, and
 * again the test would pass for the wrong reason.
 */
function secondServerBoot(): number {
  const code = `const m = await import(${JSON.stringify(CTL)});\nconsole.log(m.sweepPinnedWindows(m.tmuxSockets()));`;
  const r = Bun.spawnSync(["bun", "-e", code], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, TMUX_TMPDIR: TMPDIR, NODE_ENV: "production" },
  });
  const n = Number(r.stdout.toString().trim());
  if (!Number.isInteger(n)) throw new Error(`the second boot said: ${r.stdout.toString()} ${r.stderr.toString()}`);
  return n;
}

const opt = (name: string, w: string): string => tmux("show-options", "-qwv", "-t", w, name);
const mark = (w: string): string => opt("@agx-had-size", w);
const claim = (w: string): string => opt("@agx-had-size-by", w);
const sizeOpt = (w: string): string => opt("window-size", w);

let ctl: typeof import("../src/tmuxctl.ts");
let desk: ReturnType<typeof Bun.spawn> | null = null;
let paneId = "", win = "", second = "";

beforeAll(async () => {
  if (!HAVE_TMUX) return;
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  killServer();

  tmux("new-session", "-d", "-s", "desk", "-x", "200", "-y", "50", "sh", "-c", "printf 'ONE\\n'; exec sh");
  // A second window, so the "a dead claim is still swept" test can have one of
  // its own and the two cannot interfere through `sizeSwept` or through the
  // order they happen to run in.
  tmux("new-window", "-t", "desk", "sh", "-c", "printf 'TWO\\n'; exec sh");
  await Bun.sleep(300);
  desk = deskClient(200, 50, "desk");
  await Bun.sleep(1000);

  // `-t desk`, never `-a`: "the first pane on the server" is how a fixture ends
  // up holding one of the user's own restored sessions.
  const windows = tmux("list-windows", "-t", "desk", "-F", "#{window_id}").split("\n");
  win = windows[0] ?? "";
  second = windows[1] ?? "";
  paneId = tmux("list-panes", "-t", win, "-F", "#{pane_id}").split("\n")[0] ?? "";
  ctl = await import("../src/tmuxctl.ts");
}, 60_000);

afterAll(() => {
  try { desk?.kill(); } catch { /* already gone */ }
  if (HAVE_TMUX) killServer();
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* nothing there */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
});

describe.if(HAVE_TMUX)("a mark taken but not yet attached", () => {
  test("is claimed by this run the moment it is written", () => {
    expect(mark(win)).toBe("");
    const plan = ctl.attachArgvFor(["-L", SOCK], paneId, "claimtest", true, { cols: 60, rows: 20 });
    expect(plan, "attachArgvFor found no pane — the desk client is the precondition").not.toBeNull();

    // The gap itself, asserted rather than assumed: the argv above has NOT been
    // spawned, so there is no phone session and nothing protecting this window
    // except the claim.
    expect(tmux("list-sessions", "-F", "#{session_name}")).toBe("desk");
    expect([...ctl.phoneWindows(["-L", SOCK])]).toEqual([]);

    expect(mark(win)).toBe("none");
    expect(claim(win)).toStartWith(`${process.pid}:`);
  });

  /*
   * …and this server goes on record as one we have pinned on, which is what a
   * later boot needs to be ALLOWED to put the window back.
   *
   * Asserted here rather than in `tmux-test-isolation.test.ts`, which owns the
   * refusals, because the writer only runs on this path: `windowSizeOptions` is
   * reached through `attachArgvFor`, and `attachArgvFor` finds nothing without
   * a client attached — the pty desk in `beforeAll` is the precondition, and
   * this is the only file that has one AND drives the mark.
   *
   * Without this assertion every refusal test in the other file could be green
   * over a feature that no longer works at all: an app that never writes the
   * ledger sweeps nothing, ever, and looks exactly like an app that is being
   * careful. The mark above is what a SIGKILL strands; this is what lets the
   * next boot find it.
   */
  test("and the server it pinned on goes into the ledger the next boot reads", () => {
    expect(mark(win), "the test above is the one that writes it").toBe("none");
    // Beside the sockets it names — this fixture's own TMUX_TMPDIR, not the
    // developer's data directory. The first full run of this suite wrote
    // `${TMPDIR}/tmux-<uid>/agx-claim` into ~/.local/share/agentglass, which is
    // why `pinLedgerPath()` follows TMUX_TMPDIR when one is named.
    expect(readFileSync(join(TMPDIR, "agentglass-pinned-sockets"), "utf8"))
      .toContain(join(TMPDIR, `tmux-${process.getuid?.() ?? 0}`, SOCK));
    expect(ctl.pinnedSockets().map(([, p]) => p)).toContain(join(TMPDIR, `tmux-${process.getuid?.() ?? 0}`, SOCK));
  });

  test("survives a second server booting in that gap", () => {
    // The second boot really does walk this socket — it has the same
    // TMUX_TMPDIR, so it reads the same ledger the test above just checked, and
    // the ledger says this server is ours. What stops it is the claim, which is
    // the thing under test. Were it refused a step earlier, this would return 0
    // for a reason that has nothing to do with claims and the assertions below
    // would be green over a guard that never ran.
    expect(secondServerBoot()).toBe(0);
    expect(mark(win), "a second server stripped the mark of an attach in flight").toBe("none");
    expect(claim(win)).toStartWith(`${process.pid}:`);
  });
});

describe.if(HAVE_TMUX)("a mark whose run is gone", () => {
  /** A window that genuinely owes a restore: pinned `manual`, marked `latest`. */
  const pin = (by: string): void => {
    tmux("set-option", "-w", "-t", second, "@agx-had-size", "latest");
    tmux("set-option", "-w", "-t", second, "@agx-had-size-by", by);
    tmux("set-option", "-w", "-t", second, "window-size", "manual");
  };

  test("is still swept, which is the whole point of the sweep", () => {
    /*
     * A bare pid, and one nothing can be running under: Linux `pid_max` is
     * 4194304 by default, so /proc has no entry for this and never will.
     *
     * Both halves of that matter. Bare, because that is the shape a run with no
     * /proc readable would have written, and an early version of `claimAlive`
     * derived the same fallback for the lookup — so the strings matched, a
     * process that does not exist read as alive, and the window would have been
     * protected for ever. That is the failure this line caught.
     */
    pin("999999999");
    expect(secondServerBoot()).toBe(1);
    expect(mark(second)).toBe("");
    expect(claim(second)).toBe("");
    expect(sizeOpt(second)).toBe("latest");
  });

  test("a pid that has been reused does not inherit the claim", () => {
    // The pid is this very process, so it is unquestionably alive — and the
    // start time is not its own. Without carrying the start time this window
    // would be protected by a stranger for as long as that pid lived, and the
    // window it was meant to rescue would never be put back.
    pin(`${process.pid}:1`);
    expect(secondServerBoot()).toBe(1);
    expect(mark(second)).toBe("");
    expect(sizeOpt(second)).toBe("latest");
  });

  test("and a claim held by a live run is honoured", () => {
    // The control for the two above: same window, same owed restore, only the
    // claimant differs. Without this they would pass with the claim check
    // deleted entirely.
    tmux("set-option", "-uw", "-t", second, "window-size");
    pin(runIdOfThisProcess());
    expect(secondServerBoot()).toBe(0);
    expect(mark(second)).toBe("latest");
    expect(sizeOpt(second)).toBe("manual");
  });
});

/** `<pid>:<start time>` for this process, read the way `tmuxctl.ts` reads it:
 *  after the LAST `)`, because field 2 of /proc/<pid>/stat is a name that may
 *  contain spaces and parentheses of its own. */
function runIdOfThisProcess(): string {
  const stat = require("node:fs").readFileSync(`/proc/${process.pid}/stat`, "utf8") as string;
  return `${process.pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
}
