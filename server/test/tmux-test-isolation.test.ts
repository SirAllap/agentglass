/*
 * The suite must not be able to reach the developer's own tmux.
 *
 * This is the invariant `tmuxIsolated.ts` was written for, and it was
 * reintroduced by another door. 8983791 added a boot sweep that puts back the
 * `window-size manual` a phone left behind after a SIGKILL. It runs at module
 * scope in `index.ts`, over `tmuxSockets()` — which lists
 * `$TMUX_TMPDIR/tmux-<uid>`, and with TMUX_TMPDIR unset that directory is
 * `/tmp/tmux-<uid>`: on this machine, three sessions somebody is working in.
 * 24 of the 26 test files that spawn or import the server set no TMUX_TMPDIR,
 * so `bun test` in server/ or mobile/ could send `resize-window -A`,
 * `set-option -w window-size` and `refresh-client` at a live session. Measured
 * at the time: none of his windows carried `@agx-had-size`, so nothing had been
 * damaged — luck about that afternoon's state, not a property of the code. It
 * armed the moment a phone did a `fit` on one of his windows.
 *
 * AND THEN A THIRD TIME, through a door both halves below were blind to. The
 * two guards this file exercises open with `if (process.env.NODE_ENV !==
 * "test")`, so they say nothing about a server that is not under `bun test` —
 * and six scripts spawn exactly that server (`scripts/soak.ts`, `loadtest.ts`,
 * `perfbudget.ts`, `capture-live.ts`, `conflict-drive.ts`, `browser-drive.ts`),
 * none of them under either test root the lint reads. Measured behind a
 * recording `tmux`: a plain `bun server/src/index.ts`, with the environment
 * `perfbudget.ts` hands its child, sent `list-windows -a -F …@agx-had-size` to
 * 25 sockets in `/tmp/tmux-1000` — his `default` among them — before it had
 * answered a single request.
 *
 * So this file now has THREE halves, and the third does not ask NODE_ENV at
 * all: the sweep refuses a server it has no record of having pinned on, and
 * `tmux()` refuses any socket outside a private TMUX_TMPDIR it was handed. Both
 * are exercised below under `NODE_ENV=production`. The same measurement after:
 * zero calls, from that boot and from each of the six scripts run behind the
 * same shim.
 *
 * TWO HALVES, and neither is sufficient alone:
 *
 *   1. A REAL SWEEP, REFUSED. A tmux server is put where the code under test
 *      thinks the default socket directory is, with a window that genuinely
 *      qualifies — `@agx-had-size latest` and `window-size manual`. The sweep
 *      is then run the way `index.ts` runs it. It must leave that window
 *      exactly as it found it. Take the guard out of `tmuxctl.ts` and the
 *      second half of this file proves the window WOULD have been swept, so
 *      the first half cannot pass by being vacuous.
 *
 *   2. A LINT OVER THE TEST FILES. Measured on Bun 1.3.9: `bun test` sets
 *      NODE_ENV=test in the test process, that reaches a child spawned with
 *      `env: {...process.env}`, and it does NOT reach one spawned with a named
 *      environment — which is how nearly every suite here spawns the server,
 *      deliberately (`bun test` shares one process across files, so
 *      `...process.env` is whatever ran before). No guard inside the server can
 *      see into such a child. So the requirement is moved to where it can be
 *      checked: a test file that spawns `src/index.ts` must hand it a
 *      TMUX_TMPDIR, and this goes red the day one does not.
 *
 * The stand-in directory is built by pointing TMPDIR at a scratch path, because
 * `socketDir()` falls back to `tmpdir()` when no TMUX_TMPDIR is set and
 * `os.tmpdir()` re-reads TMPDIR on every call (measured). tmux itself ignores
 * TMPDIR and reads only TMUX_TMPDIR — also measured, and NOT a detail:
 *
 *   TMUX_TMPDIR unset, TMPDIR=<scratch>, tmux -L x  ->  /tmp/tmux-1000/x
 *   the same environment, os.tmpdir()               ->  <scratch>
 *
 * so the fixture server is started with TMUX_TMPDIR pointing at the same place:
 * same directory, reached by the two halves through different variables.
 * Asserting against the real `/tmp/tmux-<uid>` was the alternative and is
 * exactly the test that would have been green all along.
 *
 * That divergence is a fixture convenience and was never a safety property, but
 * the guard used to lean on it anyway — it asked whether a socket matched the
 * one `socketDir()` PREDICTED, so a `socketDir()` predicting the wrong
 * directory unlocked the right one. `tmuxSocketAllowed` now refuses
 * `/tmp/tmux-<uid>/default` as a constant as well, which is why this file can
 * keep redirecting TMPDIR without that being what makes it safe.
 *
 * A THIRD variable, found after this file was first written and the reason it
 * has a `$TMUX` test: agents in this repo run INSIDE the developer's tmux, and
 * `$TMUX` names his socket outright — ahead of TMUX_TMPDIR — for any command
 * with no `-S` and no `-L`. A guard that asked TMUX_TMPDIR where a bare command
 * would land was therefore answering about the wrong socket in every test file
 * that sets one. See "a private TMUX_TMPDIR does not buy back the socket $TMUX
 * names" below for the measurement.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";

/*
 * Short, for the 108-byte unix socket path limit — a pid is five or six of
 * those bytes.
 *
 * Per PROCESS, and this file was the last one in the suite that was not. It
 * hosts the lint below, which now requires exactly this of every file that runs
 * tmux, and a rule that exempts its own host is not a rule.
 *
 * It is also not theoretical here, which is what settled it. Five pairs of
 * concurrent copies, measured: three of the five lost a test, always the same
 * one — `EEXIST: symlink '/tmp/agx-tmux-guard/looks-innocent'`, one run's
 * `symlinkSync` landing on the link the other had not removed yet. Less often
 * than the 3-8 apiece the server fixtures lost, because this file's whole life
 * is 64ms rather than seconds; a smaller window is not a closed one.
 */
const STAND_IN = `/tmp/agx-tmux-guard-${process.pid}`;
const UID = process.getuid?.() ?? 0;
const SOCKET = join(STAND_IN, `tmux-${UID}`, "default");
const HAVE_TMUX = !!Bun.which("tmux") && process.platform === "linux";

/*
 * A SECOND fixture, deliberately OUTSIDE the stand-in directory.
 *
 * The confinement guard's whole claim is "a process handed a private
 * TMUX_TMPDIR may act on servers inside it and nowhere else", and the socket
 * that proves the second half has to be a real one somewhere else. His own is
 * the obvious somewhere else and is exactly what must never be used: a run
 * where the guard is missing is the run the test exists for, and that is the
 * run it would reach him on. So the "elsewhere" is another private server of
 * ours, and the assertion is the same one.
 */
const OUTSIDE_DIR = `/tmp/agx-tmux-out-${process.pid}`;
const OUTSIDE = join(OUTSIDE_DIR, `tmux-${UID}`, "default");

/** Where the pin ledger lands: `tmuxctl.ts` puts it beside the sockets it is a
 *  record of, so it is one per TMUX_TMPDIR — and the tests below move
 *  TMUX_TMPDIR between the two fixtures on purpose, so which file is in force
 *  is part of what is being asserted rather than a detail. */
const ledgerIn = (tmpdir: string): string => join(tmpdir, "agentglass-pinned-sockets");

const PREV_TMPDIR = process.env.TMPDIR;
const PREV_TMUX_TMPDIR = process.env.TMUX_TMPDIR;
const PREV_NODE_ENV = process.env.NODE_ENV;

/** The fixture's own tmux, always addressed by the socket PATH — never by a
 *  bare `-L default`, which would resolve against this process's environment
 *  and so against whatever the test under way has done to it. */
const fx = (...args: string[]): string =>
  Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-S", SOCKET, ...args], { stdout: "pipe", stderr: "pipe", env: process.env })
    .stdout.toString().trim();

/** The same, for the fixture outside the stand-in directory. */
const out = (...args: string[]): string =>
  Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-S", OUTSIDE, ...args], { stdout: "pipe", stderr: "pipe", env: process.env })
    .stdout.toString().trim();

const opt = (target: string, name: string): string => fx("show-options", "-qwv", "-t", target, name);

/** Put sockets on record as ones this installation has pinned a window on —
 *  the file `tmuxctl.ts` writes in `windowSizeOptions` and reads at boot.
 *  Written here rather than driven through the app, because the sweep's whole
 *  subject is a mark left by a run that is GONE, and this process is not it.
 *  `dir` is the TMUX_TMPDIR the ledger belongs to, always passed explicitly:
 *  a helper that read `process.env` would silently write the wrong file in the
 *  one test that points the two at different fixtures. */
const ledger = (dir: string, ...paths: string[]): void => {
  const file = ledgerIn(dir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, paths.length ? `${paths.join("\n")}\n` : "");
};

/** The directory `tmuxctl.ts` currently believes tmux keeps its sockets in —
 *  the stand-in while this file is running, the real one otherwise. Recomputed
 *  per call for the same reason `socketDir()` is: the tests move TMUX_TMPDIR.
 *
 *  Tracks `socketDir()` only for the arrangements this file puts it in, which
 *  are TMUX_TMPDIR unset or naming a real directory. It deliberately does NOT
 *  model the set-but-absent case — there `socketDir()` falls back and this
 *  would not — so it is never used in the vanished-directory test below. */
const socketDirNow = (): string => join(process.env.TMUX_TMPDIR || process.env.TMPDIR || "/tmp", `tmux-${UID}`);

/*
 * The files under a lint's root, for a root that a branch may legitimately not
 * have.
 *
 * Both lints below list their roots rather than discovering them, and let
 * `readdirSync` throw on one that is not there — deliberately, because a
 * typo'd root that silently matches nothing is how a lint goes quiet. That
 * reasoning is still right and is kept.
 *
 * What it did not anticipate is the release stack. `mobile/` arrives in the
 * THIRD branch of three: on release/app and release/desktop-build there is no
 * phone in the tree at all, and this threw twice as "Unhandled error between
 * tests". That did not turn a test red — it stopped both lints from ever
 * building their file list, so on the two branches where they were the only
 * thing guarding the tmux rules, they were not running. A lint that is missing
 * is worse than a lint that is failing, because nothing says so.
 *
 * So absence is allowed only where it is DECLARED, and only where the product
 * itself is absent: `mobile/test` may be missing when the phone is not in the
 * tree, and a typo like `mobile/tests` still throws the moment it is. Nothing
 * else may be missing at all.
 *
 * The sentinel is a TRACKED FILE — `mobile/package.json` — and not the
 * directory the root lives under, which is what this was written as first and
 * is wrong for a reason worth keeping: `git checkout` does not remove untracked
 * files, so switching from the phone branch to this one leaves `mobile/`
 * standing with a `node_modules` in it and nothing else. Measured on exactly
 * that tree: the directory existed, `mobile/test` did not, and the two lints
 * were skipped again with the same two unhandled errors. A clean CI checkout
 * would have passed, which is the kind of green that is luck rather than a
 * property.
 */
type LintRoot = { dir: string; ext: string; absentWithout?: string };
const lintFiles = (repo: string, root: LintRoot): { rel: string; dir: string; src: string }[] => {
  if (root.absentWithout && !existsSync(join(repo, root.absentWithout))) return [];
  return readdirSync(join(repo, root.dir))
    .filter((n) => n.endsWith(root.ext))
    .map((n) => ({ rel: `${root.dir}/${n}`, dir: root.dir, src: readFileSync(join(repo, root.dir, n), "utf8") }));
};

let ctl: typeof import("../src/tmuxctl.ts");
let window = "";

let outWindow = "";

beforeAll(async () => {
  if (!HAVE_TMUX) return;
  mkdirSync(join(STAND_IN, `tmux-${UID}`), { recursive: true, mode: 0o700 });
  fx("kill-server");
  fx("new-session", "-d", "-s", "desk");
  window = fx("display-message", "-p", "-t", "desk", "#{window_id}");

  // What a phone's `fit` leaves behind when the server is SIGKILLed: the mark
  // that says the app took the option, and the pinned value it took it from.
  fx("set-option", "-w", "-t", window, "@agx-had-size", "latest");
  fx("set-option", "-w", "-t", window, "window-size", "manual");

  // The same bait, on a server outside the stand-in directory: what a socket
  // the confinement guard must refuse looks like when it is genuinely sweepable.
  mkdirSync(join(OUTSIDE_DIR, `tmux-${UID}`), { recursive: true, mode: 0o700 });
  out("kill-server");
  out("new-session", "-d", "-s", "elsewhere");
  outWindow = out("display-message", "-p", "-t", "elsewhere", "#{window_id}");
  out("set-option", "-w", "-t", outWindow, "@agx-had-size", "latest");
  out("set-option", "-w", "-t", outWindow, "window-size", "manual");

  // The code under test now believes the default socket directory is the
  // stand-in. Set AFTER the fixture is built, so the fixture's own tmux calls
  // above are unaffected by it either way.
  process.env.TMPDIR = STAND_IN;
  delete process.env.TMUX_TMPDIR;
  ctl = await import("../src/tmuxctl.ts");
});

afterAll(() => {
  if (PREV_TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = PREV_TMPDIR;
  if (PREV_TMUX_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = PREV_TMUX_TMPDIR;
  // NODE_ENV is flipped to production inside one describe below. Restoring it
  // here as well as in each test's finally is not belt-and-braces for its own
  // sake: `bun test` runs every file in ONE process, so a file that left
  // NODE_ENV wrong would take the test-mode guards away from every file after
  // it — which is the whole defence this one is about.
  if (PREV_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = PREV_NODE_ENV;
  if (!HAVE_TMUX) return;
  fx("kill-server");
  out("kill-server");
  try { rmSync(STAND_IN, { recursive: true, force: true }); } catch { /* gone */ }
  try { rmSync(OUTSIDE_DIR, { recursive: true, force: true }); } catch { /* gone */ }
});

describe.if(HAVE_TMUX)("a suite with no TMUX_TMPDIR cannot reach the default socket", () => {
  test("the fixture really is a window the sweep would take", () => {
    // Not an assertion about the guard — an assertion that the bait is live.
    // Without it every expectation below would hold on a window the sweep was
    // never going to touch, and this file would pass with the guard deleted.
    expect(opt(window, "@agx-had-size")).toBe("latest");
    expect(opt(window, "window-size")).toBe("manual");
  });

  test("discovery finds nothing, so the sweep is handed nothing", () => {
    // The socket is right there in the directory: `tmuxSockets` would list it.
    expect(readdirSync(join(STAND_IN, `tmux-${UID}`))).toContain("default");
    expect(ctl.tmuxSockets()).toEqual([]);
    // …including when a client's own spelling is offered. Under `bun test` that
    // spelling came out of /proc, and /proc here has his tmux in it.
    expect(ctl.tmuxSockets(["-S", SOCKET])).toEqual([]);
  });

  test("the boot sweep, run exactly as index.ts runs it, changes nothing", () => {
    expect(ctl.sweepPinnedWindows(ctl.tmuxSockets())).toBe(0);
    // And handed the socket directly, which is the `releaseStale` door that
    // discovery cannot close.
    expect(ctl.sweepPinnedWindows([["-S", SOCKET]])).toBe(0);
    expect(opt(window, "@agx-had-size")).toBe("latest");
    expect(opt(window, "window-size")).toBe("manual");
  });

  /*
   * The third guard — `tmux()` refusing the default socket — is asserted and
   * never exercised, and that is the whole point.
   *
   * `socket: []` is what a developer's plain `tmux` (no `-S`, no `-L`) resolves
   * to and what `socketOf()` returns for one — measured, the developer's own
   * clients here are `tmux -2 attach -t <name>` and `tmux new-session -A -s
   * <name>`, so `socketFromArgv` gives `[]` for both. It is the path neither
   * `tmuxSockets` nor `sweepPinnedWindows` can see: a `TmuxTarget` built from
   * /proc. And a bare invocation cannot be aimed at a stand-in — only `-S` and
   * `-L` redirect it, and using either makes it a different case. So driving a
   * real command through it to watch the refusal would aim it at the live
   * server, and would REACH it on any run where the guard was missing, which is
   * the one run this test exists for.
   *
   * That is not hypothetical: an earlier attempt to check this by removing the
   * guard for thirty seconds did exactly that. `setStatusLine(…, false)` got
   * past `statusInConfig`, its session-scoped writes failed against a session id
   * the fixture owned and the live server did not, and its `bind-key` — which
   * takes no `-t` and is therefore global — succeeded, wrapping a real
   * `prefix ,` and `prefix .` in an `if-shell` nobody asked for.
   *
   * The removal proof is done here instead, where it costs nothing: with all
   * four guards taken out, five tests in this file go red, including the real
   * sweep above. Run behind a `tmux` shim that refuses and records anything
   * resolving to the live default socket, that removal produced ZERO such
   * attempts — so the proof and the safety are separable, and the proof is the
   * one that lives in the repo.
   */
  test("a command aimed at the default socket by /proc is refused", () => {
    expect(ctl.tmuxSocketAllowed([])).toBe(false);
    expect(ctl.tmuxSocketAllowed(["-L", "default"])).toBe(false);
    expect(ctl.tmuxSocketAllowed(["-S", join(socketDirNow(), "default")])).toBe(false);
    // And the sockets four suites legitimately run their own server on, in that
    // same directory, stay reachable — a guard that refused those would take
    // tmux-bar, tmux-tabs, tmux-stale and pane-routes down with it.
    expect(ctl.tmuxSocketAllowed(["-L", "agx-bartest-1"])).toBe(true);
    expect(ctl.tmuxSocketAllowed(["-S", join(socketDirNow(), "agx-panes-abc")])).toBe(true);
    // `SOCKET` is deliberately not in that list: the fixture IS a socket called
    // `default`, which is the whole point of it, so this rule refuses it too.
    expect(ctl.tmuxSocketAllowed(["-S", SOCKET])).toBe(false);
  });

  /*
   * The door a private TMUX_TMPDIR does NOT close, and the reason this file
   * grew a second half.
   *
   * Agents in this repo run inside his tmux, so `bun test` inherits a `$TMUX`
   * naming his socket — and `$TMUX` beats TMUX_TMPDIR for a flagless `tmux`.
   * Measured on 3.6a with an empty directory to hide behind:
   *
   *   TMUX_TMPDIR=/tmp/agx-probe-empty tmux list-sessions
   *     -> the five sessions somebody was working in  ** the developer's own **
   *   env -u TMUX  (the same command)
   *     -> error connecting to /tmp/agx-probe-empty/tmux-1000/default
   *
   * So the FIRST version of this guard, which asked `socketDir()` where a bare
   * command would land, was wrong in exactly the direction that costs
   * something. Measured against it, in one process:
   *
   *   socketPath([])       /tmp/agx-probe-empty/tmux-1000/default
   *   guard says allowed   true
   *   bare tmux reached    the five sessions somebody was working in
   *
   * `$TMUX` is set here rather than read, so this is the same test on his desk
   * and on a CI runner that is not inside tmux at all.
   */
  test("a private TMUX_TMPDIR does not buy back the socket $TMUX names", () => {
    const PREV = process.env.TMUX;
    process.env.TMUX_TMPDIR = STAND_IN;
    process.env.TMUX = `${SOCKET},4242,0`;
    try {
      expect(ctl.socketPath([])).toBe(SOCKET);
      expect(ctl.tmuxSocketAllowed([])).toBe(false);
      // …and a suite that names its own server is still let through, which is
      // what stops this from being a guard that just turns tmux off.
      expect(ctl.tmuxSocketAllowed(["-L", "agx-bartest-1"])).toBe(true);
      expect(ctl.tmuxSocketAllowed(["-S", join(STAND_IN, `tmux-${UID}`, "agx-panes-abc")])).toBe(true);
    } finally {
      delete process.env.TMUX_TMPDIR;
      if (PREV === undefined) delete process.env.TMUX; else process.env.TMUX = PREV;
    }
  });

  test("and it is allowed again the moment a private TMUX_TMPDIR names one", () => {
    // `$TMUX` cleared, because this is the case of a machine that is NOT inside
    // tmux — the CI shape, and the one where TMUX_TMPDIR is the whole story.
    // Left set, the test above is what applies instead.
    const PREV = process.env.TMUX;
    process.env.TMUX_TMPDIR = STAND_IN;
    delete process.env.TMUX;
    try { expect(ctl.tmuxSocketAllowed([])).toBe(true); }
    finally {
      delete process.env.TMUX_TMPDIR;
      if (PREV !== undefined) process.env.TMUX = PREV;
    }
  });

  /*
   * The third door, and the one that was open the longest: a TMUX_TMPDIR that
   * names a directory which is NOT THERE.
   *
   * The guard tested the VARIABLE (`!process.env.TMUX_TMPDIR`), so this read as
   * isolation. tmux tests the DIRECTORY, and when it cannot make
   * `$TMUX_TMPDIR/tmux-<uid>` it falls back to /tmp/tmux-<uid> with no warning
   * on stderr and a zero exit. Measured on 3.6a, `$TMUX` cleared:
   *
   *   TMUX_TMPDIR=/tmp/does-not-exist tmux -f /dev/null -L default list-sessions
   *     -> the sessions somebody was working in     ** his live server **
   *   TMUX_TMPDIR=<a real dir>        tmux -f /dev/null -L zzz     list-sessions
   *     -> error connecting to <that dir>/tmux-1000/zzz
   *
   * So the one arrangement that unlocked the guard was also the one where the
   * command went to his server. Reproduced through this module before the fix,
   * with NODE_ENV=test and `$TMUX` cleared:
   *
   *   socketPath([])        /tmp/agx-test-tmux-ABSENT/tmux-1000/default
   *   guard says allowed    true
   *   what actually ran     display-message -p -t @1 #{window_width}
   *                         show-options -gv prefix          ** on his server **
   *
   * Not a contrived precondition: `tmuxTmp.ts` makes one fixed directory and
   * exported the path whether or not the mkdir worked, so one stale
   * /tmp/agx-test-tmux owned by root handed every spawned child exactly this.
   *
   * The directory is named and never created — `mkdtemp` would defeat the test
   * by making one. Under STAND_IN so nothing outside the fixture is touched.
   */
  test("a TMUX_TMPDIR whose directory is not there refuses, it does not unlock", () => {
    const PREV = process.env.TMUX;
    const VANISHED = join(STAND_IN, "swept-away-by-something");
    process.env.TMUX_TMPDIR = VANISHED;
    delete process.env.TMUX;
    try {
      expect(existsSync(VANISHED)).toBe(false);
      /*
       * THE PREMISE OF THIS TEST CHANGED, and the new one is stronger.
       *
       * It used to be that `socketDir()` answered the machine's real directory
       * when the named one was missing — so a bare `tmux` would have landed on
       * his servers, and refusing was the only protection available. That
       * fallback is gone: a TMUX_TMPDIR that is set is used whether or not it
       * exists, because whoever set it meant somewhere else, and tmux itself
       * creates the directory it is pointed at.
       *
       * So a bare `tmux` is no longer a way back to his sockets, and there is
       * nothing left to refuse about it. What must still be refused is the
       * thing that names his directory OUT LOUD — a path spelled by hand — and
       * that is asserted right below.
       */
      expect(ctl.tmuxSocketAllowed([])).toBe(true);
      expect(ctl.tmuxSocketAllowed(["-L", "default"])).toBe(true);
      // Naming his socket directory explicitly is still refused, missing
      // TMUX_TMPDIR or not: that one cannot be a mistake about where you are.
      expect(ctl.tmuxSocketAllowed(["-S", join(`/tmp/tmux-${UID}`, "default")])).toBe(false);
      // Discovery too, and this is the half that makes the order matter.
      // `socketDir()` no longer answers the absent path — it falls back — so
      // `readdirSync` would now be handed a directory that EXISTS and has
      // sockets in it. Here that is the stand-in (TMPDIR is redirected in
      // beforeAll) whose `default` is the fixture; everywhere else, and in
      // production, the same fallback is /tmp/tmux-<uid>: his. Either way,
      // making the model honest is only safe because `blindTmuxBanned` is
      // consulted BEFORE `socketDir()` in `tmuxSockets`.
      expect(ctl.tmuxSockets()).toEqual([]);
      expect(ctl.sweepPinnedWindows(ctl.tmuxSockets())).toBe(0);
      // And a suite naming its own server is still let through, so this is a
      // refusal and not tmux being switched off.
      expect(ctl.tmuxSocketAllowed(["-L", "agx-bartest-1"])).toBe(true);
    } finally {
      delete process.env.TMUX_TMPDIR;
      if (PREV !== undefined) process.env.TMUX = PREV;
    }
  });

  /*
   * The spellings, because all three name his socket and all three used to be
   * allowed by a guard that compared paths as strings.
   *
   * Nothing in the app spells a socket this way today. "Nothing does it today"
   * was also true of the two holes this guard has already been fixed for, and
   * `-S` values arrive from `socketOf()` — the argv of whatever tmux client
   * happens to be in /proc — which is not a set this repo controls.
   */
  test("the same socket spelt four other ways is the same socket", () => {
    const PREV = process.env.TMUX;
    process.env.TMUX_TMPDIR = STAND_IN;
    delete process.env.TMUX;
    const his = `/tmp/tmux-${UID}`;
    try {
      // Lexical: folded by `normalize` in `socketPath`, before any comparison.
      for (const spelling of [
        `/${his}/default`,          // //tmp/tmux-1000/default
        `${his}/./default`,
        `${his}/../tmux-${UID}/default`,
      ]) expect(ctl.tmuxSocketAllowed(["-S", spelling]), spelling).toBe(false);
    } finally {
      delete process.env.TMUX_TMPDIR;
      if (PREV !== undefined) process.env.TMUX = PREV;
    }
  });

  /*
   * And the fifth spelling, which no amount of `normalize` can see.
   *
   * A symlink is not a lexical variation, so this is the one case that needs
   * `realpathSync` — and it is asserted against the FIXTURE's socket, not the
   * developer's, for two reasons: it holds on a CI runner that has no
   * /tmp/tmux-<uid>/default to point at (realpath of an absent path throws, and
   * the fallback would silently make this vacuous), and it needs no symlink
   * aimed at a live server to exist even for the length of a test.
   *
   * TMUX_TMPDIR deliberately left UNSET so `socketDir()` is the stand-in and
   * refusal 3 is the one under test.
   */
  test("a symlink to a banned socket is the banned socket", () => {
    const PREV = process.env.TMUX;
    delete process.env.TMUX;
    const link = join(STAND_IN, "looks-innocent");
    try {
      symlinkSync(SOCKET, link);
      // The bait is live: the target really is a socket the guard refuses.
      expect(ctl.tmuxSocketAllowed(["-S", SOCKET])).toBe(false);
      expect(ctl.tmuxSocketAllowed(["-S", link])).toBe(false);
    } finally {
      try { rmSync(link, { force: true }); } catch { /* never made */ }
      if (PREV !== undefined) process.env.TMUX = PREV;
    }
  });

  test("a private TMUX_TMPDIR and a record of pinning there unlock it — and then it sweeps", () => {
    // The half that gives the four above their meaning. Same process, same
    // fixture, same window: the only things that changed are the variable a
    // test is expected to set and the ledger entry a run that pinned this
    // server would have left. If this did not restore, everything above would
    // be green because the sweep is broken rather than because it was refused.
    process.env.TMUX_TMPDIR = STAND_IN;
    ledger(STAND_IN, SOCKET);
    try {
      expect(ctl.sweepPinnedWindows(ctl.tmuxSockets())).toBe(1);
      expect(opt(window, "window-size")).toBe("latest");
      expect(opt(window, "@agx-had-size")).toBe("");
    } finally {
      delete process.env.TMUX_TMPDIR;
      ledger(STAND_IN);
    }
  });
});

/*
 * The guards that do not ask NODE_ENV, and the population that made them
 * necessary.
 *
 * Everything above is about `bun test`. It is enforced by `blindTmuxBanned` and
 * `tmuxSocketAllowed`, and BOTH open with `if (process.env.NODE_ENV !== "test")`
 * — so a server that is not under `bun test` had no guard at all. Six scripts
 * spawn exactly that server (`scripts/soak.ts`, `loadtest.ts`, `perfbudget.ts`,
 * `capture-live.ts`, `conflict-drive.ts`, `browser-drive.ts`); the lint at the
 * bottom of this file now covers them, and this describe covers the case where
 * a lint is blind again — a seventh spawner, or one that builds its argv
 * somewhere a regex cannot follow.
 *
 * So NODE_ENV is set to "production" here, which is the whole point: every
 * assertion below holds for a process that looks exactly like the desktop app.
 * The two rules being exercised are
 *
 *   1. the sweep acts only on a server this INSTALLATION has a record of
 *      pinning a window on (the pin ledger, written beside the database), and
 *   2. `tmux()` refuses any socket outside a private TMUX_TMPDIR the process
 *      was handed, whatever the command.
 *
 * and the deliberate arrangement is that TMUX_TMPDIR points at the stand-in, so
 * discovery finds the bait and confinement permits it. The only thing left
 * between the sweep and a window that genuinely qualifies is the ledger.
 */
describe.if(HAVE_TMUX)("a server that is not under `bun test` still cannot sweep what it does not own", () => {
  /*
   * All five run against the OUTSIDE fixture, and that is not arbitrary.
   * `sizeSwept` retires a socket after one successful sweep — deliberately, so
   * the boot walk and a panel's first contact do not both do it — so exactly
   * ONE test per process may see a real restore on a given server, and the
   * fixture inside the stand-in has already spent its one on the describe
   * above. Refusals do not consume it: the new guard declines before
   * `sizeSwept.add`, for the reason spelled out beside it.
   */
  const asProduction = (tmpdir: string, body: () => void): void => {
    process.env.NODE_ENV = "production";
    process.env.TMUX_TMPDIR = tmpdir;
    try { body(); } finally {
      if (PREV_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = PREV_NODE_ENV;
      delete process.env.TMUX_TMPDIR;
      ledger(tmpdir);
    }
  };
  const bait = (): string[] => [
    out("show-options", "-qwv", "-t", outWindow, "@agx-had-size"),
    out("show-options", "-qwv", "-t", outWindow, "window-size"),
  ];

  test("the fixture really is a window a production sweep would take", () => {
    // The bait is live, asserted before anything is claimed about refusing it —
    // the same guard-on-the-fixture the describe above opens with.
    expect(bait()).toEqual(["latest", "manual"]);
  });

  test("with no record of ever pinning there, the boot sweep issues nothing", () => {
    asProduction(OUTSIDE_DIR, () => {
      ledger(OUTSIDE_DIR);
      // Both doors. `pinnedSockets()` is what index.ts hands the sweep, and it
      // is empty — so the boot of a script's server does not even list a socket
      // directory. `[["-S", OUTSIDE]]` is the `releaseStale` door, which
      // arrives with a socket read off a live tmux client in /proc and cannot
      // be asked to remember anything.
      expect(ctl.pinnedSockets()).toEqual([]);
      expect(ctl.sweepPinnedWindows(ctl.pinnedSockets())).toBe(0);
      expect(ctl.sweepPinnedWindows([["-S", OUTSIDE]])).toBe(0);
      // And the window is untouched — MARK INCLUDED. A sweep that walked it and
      // only declined to resize would still have stripped the mark, which is
      // precisely what was measured against a stand-in baited like this:
      // `swept: 1, window-size after: latest, mark after: (empty)`.
      expect(bait()).toEqual(["latest", "manual"]);
    });
  });

  test("discovery is no longer what feeds it", () => {
    asProduction(OUTSIDE_DIR, () => {
      ledger(OUTSIDE_DIR);
      // The distinction the fix turns on, stated as an assertion. `tmuxSockets`
      // still answers "every tmux server this user could be running" — it has
      // to, that is how the app finds which pane an agent is in — while the
      // sweep is now fed "the servers this install has pinned on". The old boot
      // line handed the first list to the second question, and with TMUX_TMPDIR
      // unset that list is the developer's own directory.
      expect(ctl.tmuxSockets().length).toBeGreaterThan(0);
      expect(ctl.pinnedSockets()).toEqual([]);
    });
  });

  test("a socket outside the private TMUX_TMPDIR is refused even with a record", () => {
    // Everything says yes except confinement: NODE_ENV is production, the
    // ledger names this exact socket, and the window genuinely qualifies. Only
    // TMUX_TMPDIR points somewhere else.
    asProduction(STAND_IN, () => {
      // The record goes in the ledger of the directory IN FORCE, which is the
      // stand-in — that is where a process confined there keeps its pins, and
      // naming a socket from somewhere else in it is precisely the arrangement
      // confinement has to refuse.
      ledger(STAND_IN, OUTSIDE);
      expect(ctl.pinnedSockets()).toEqual([["-S", OUTSIDE]]);
      expect(ctl.tmuxSocketConfined(["-S", OUTSIDE])).toBe(false);
      expect(ctl.sweepPinnedWindows(ctl.pinnedSockets())).toBe(0);
      expect(bait()).toEqual(["latest", "manual"]);
    });
  });

  test("and the same socket IS swept once it is the directory in force", () => {
    // The half that stops all four above passing because the fixture is inert
    // or the sweep is broken. Same process, same server, same window, same
    // ledger entry, still NODE_ENV=production: only TMUX_TMPDIR moves.
    asProduction(OUTSIDE_DIR, () => {
      ledger(OUTSIDE_DIR, OUTSIDE);
      expect(ctl.tmuxSocketConfined(["-S", OUTSIDE])).toBe(true);
      expect(ctl.sweepPinnedWindows(ctl.pinnedSockets())).toBe(1);
      expect(bait()).toEqual(["", "latest"]);
    });
  });
});

/*
 * The other half: the children the guard cannot reach.
 *
 * Source-reading, like `ingest-origin.test.ts` and `readme-remote-claims.test.ts`
 * — the only way to check a property of a spawn that has not happened yet.
 *
 * ITS POPULATION WAS THE BUG THE THIRD TIME ROUND. This lint used to read
 * `const roots = ["server/test", "mobile/test"]` over `*.test.ts`, because the
 * two failures before it had both come from a test file. Six scripts spawn the
 * same server and are in neither root: `scripts/soak.ts`, `loadtest.ts`,
 * `perfbudget.ts`, `capture-live.ts`, `conflict-drive.ts`, `browser-drive.ts`.
 * Each carefully redirects AGENTGLASS_DB, XDG_CONFIG_HOME, XDG_DATA_HOME and
 * XDG_CACHE_HOME — the author of every one of them was thinking about
 * isolation — and none set TMUX_TMPDIR or NODE_ENV, so the server they start
 * had no guard of any kind: `blindTmuxBanned` and `tmuxSocketAllowed` both open
 * with `if (process.env.NODE_ENV !== "test")`. Measured with the exact
 * environment `perfbudget.ts` handed its child, `$TMUX` cleared: `allowed([])`
 * true, `tmuxSockets()` 25 sockets, his `default` among them; and against an
 * isolated stand-in baited like a killed run, that server swept it.
 *
 * So the population is now "a file that spawns the server", wherever it lives,
 * and the three roots are listed rather than inferred so adding a fourth is a
 * decision somebody makes on purpose.
 *
 * The DETECTOR had to grow with it, and that is where the care goes. A script
 * does not spell the entry point the way a test does — `spawn({ cmd: ["bun",
 * join(ROOT, "server", "src", "index.ts")] })` against `Bun.spawn(["bun",
 * "run", SRC])` — and the naive widening (any spawn in a file mentioning
 * `src/index.ts`) pulls in four files that spawn something else entirely and
 * merely name the path: `build-stamp.test.ts` and `headcheck.test.ts` WRITE a
 * fixture `server/src/index.ts` into a scratch repo, `desktop-sidecar-failure`
 * describes the sidecar's argv in prose, and `scripts/headcheck.ts` quotes a
 * tsc diagnostic. Requiring the spelling to be the one an argv uses — the
 * `"bun", "run"` pair for a test, the `"src", "index.ts"` join fragment for a
 * script — separates them exactly: 18 + 2 + 6, and those four out.
 *
 * WHAT THIS STILL CANNOT SEE, since the last two rounds were both something a
 * lint could not see: a file that spawns the server through a helper in another
 * module, or builds `["bun", SERVER]` from a path assembled somewhere else.
 * That is why it is not the only defence any more — `tmuxctl.ts` refuses any
 * socket outside a named TMUX_TMPDIR from `tmux()` itself, and the boot sweep
 * refuses any server this installation has no ledger record of pinning on, both
 * without consulting NODE_ENV. This lint is what keeps the cheap, explicit half
 * in place; those two are what hold when it is blind again.
 */
describe("nothing that spawns the server lets it find the developer's tmux", () => {
  const repo = join(import.meta.dir, "..", "..");
  /** Listed, not discovered: a new root is a decision, and a typo'd one that
   *  silently matched nothing is how a lint goes quiet. `readdirSync` throws on
   *  a root that is not there, which is the loud version of the same thing. */
  const roots: LintRoot[] = [
    { dir: "server/test", ext: ".test.ts" },
    // Absent on the two branches of the release stack below the phone — see
    // `lintFiles`, which is where that is allowed and where it stops being
    // allowed the moment `mobile/` exists.
    { dir: "mobile/test", ext: ".test.ts", absentWithout: "mobile/package.json" },
    { dir: "scripts", ext: ".ts" },
  ];

  /**
   * A file that starts the real server as a child process.
   *
   * A spawn AND the entry point named the way an argv names it. Both halves
   * matter: `serve-proxy.test.ts` builds its argv into a variable first, so
   * matching the literal `Bun.spawn(["bun", "run", src])` would miss the two
   * servers it starts — and matching a bare `src/index.ts` anywhere in the file
   * picks up the four fixtures above that write that path rather than run it.
   */
  const spawnsTheServer = (src: string): boolean => {
    if (!/(?:Bun\.)?spawn(?:Sync)?\(/.test(src)) return false;
    // `spawn(["bun", "run", …])` — every test that starts a server.
    if (/"bun",\s*"run"/.test(src) && src.includes("src/index.ts")) return true;
    // `join(ROOT, "server", "src", "index.ts")` — every script that does. The
    // comma form is what makes it unambiguous: the four files that only NAME
    // the entry point all write it as one `"server/src/index.ts"` string.
    return /"src",\s*"index\.ts"/.test(src);
  };

  const files = roots.flatMap((r) => lintFiles(repo, r).filter((f) => spawnsTheServer(f.src)));

  test("every one of them passes TMUX_TMPDIR in the child's environment", () => {
    // `TMUX_TMPDIR:` with the colon: the object-literal key, in an env being
    // handed to a child. `process.env.TMUX_TMPDIR` — which several files read
    // to clean a socket up afterwards — is not that, and counting it would
    // have let `pane-routes.test.ts` through while its server still walked
    // /tmp/tmux-1000.
    const offenders = files.filter((f) => !/TMUX_TMPDIR:/.test(f.src)).map((f) => f.rel);
    expect(offenders, "these spawn server/src/index.ts, whose boot sweep and /panes route then walk the developer's own tmux socket directory; give the child TMUX_TMPDIR (server/test/tmuxTmp.ts for a test, scripts/tmuxTmp.ts for a script)").toEqual([]);
  });

  test("and a script's is a directory something actually made", () => {
    /*
     * The tighter half, for scripts only, and it encodes a measurement rather
     * than a preference: on tmux 3.6a a TMUX_TMPDIR whose directory is ABSENT
     * falls back to /tmp/tmux-<uid> silently, so a hand-rolled path that was
     * never created is worse than setting nothing — it reads as isolation to
     * every guard in the server while tmux uses his directory. That is the
     * exact hole `server/test/tmuxTmp.ts` was fixed for.
     *
     * A test file is not held to this: they build theirs with `mkdtempSync`,
     * which creates or throws, or take `TMUX_TEST_TMPDIR` from a module that
     * mkdirs at import and throws if it cannot. A script has neither a fixture
     * module nor a `beforeAll`, so `privateTmuxDir()` — which mkdirs and throws
     * — is the one place that guarantee can live.
     *
     * The CALL, `privateTmuxDir(`, and never the bare identifier: the sibling
     * lint below was written matching `TMUX_ISOLATED` by name and a file that
     * still IMPORTED it while no longer spreading it passed.
     */
    const offenders = files
      .filter((f) => f.dir === "scripts" && !/TMUX_TMPDIR:\s*privateTmuxDir\(/.test(f.src))
      .map((f) => f.rel);
    expect(offenders, "a script must take its TMUX_TMPDIR from privateTmuxDir(home) (scripts/tmuxTmp.ts), which creates the directory or throws — tmux falls back to /tmp/tmux-<uid> when TMUX_TMPDIR names one that is not there").toEqual([]);
  });

  test("the lint is looking at the files it thinks it is", () => {
    // A guard on the guard: if the detector stopped matching — a spawn helper
    // renamed, the suite moved — `offenders` would be empty for the wrong
    // reason and this file would pass while protecting nothing.
    //
    // The six scripts by name, because they are the population this lint did
    // not have and a detector that silently stopped seeing them would leave
    // exactly the hole it was widened to close. The test roots stay a count:
    // 20 files match today and they come and go with the suite.
    const rels = files.map((f) => f.rel);
    for (const s of ["soak", "loadtest", "perfbudget", "capture-live", "conflict-drive", "browser-drive"]) {
      expect(rels, `scripts/${s}.ts spawns the server; if this lint cannot see it any more, it is not checking it either`).toContain(`scripts/${s}.ts`);
    }
    expect(rels.filter((r) => r.endsWith(".test.ts")).length).toBeGreaterThanOrEqual(15);
  });
});

/*
 * The class the lint above cannot see at all, and what it took to find out.
 *
 * That lint's population is "files that spawn `server/src/index.ts`", and its
 * question is "does the child get a TMUX_TMPDIR". A file that runs the tmux
 * BINARY itself is not in that population — it never spawns the server — so no
 * amount of tightening the question reaches it. `tmux-stale.test.ts` sat
 * outside it on `const SOCK = ["-L", "agx-stale-test"]`: a private socket NAME,
 * the developer's socket DIRECTORY, and — no `-f` — the developer's
 * CONFIGURATION. Its header claimed all three.
 *
 * How it was found, because reading the files had already failed to. The whole
 * server suite was run behind a `tmux` first on PATH that resolves the socket
 * by tmux's own rule and writes down where each call lands. 333 of 1087 calls
 * landed in `/tmp/tmux-<uid>`, and the CALLERS are what named the real problem:
 *
 *   .tmux/plugins/tpm/tpm                                      his plugin manager
 *   .tmux/plugins/tmux-resurrect/resurrect.tmux
 *   .tmux/plugins/tmux-continuum/scripts/continuum_restore.sh  <- this one RAN
 *
 * Not "would have inherited his config": his config was executing, and the
 * restore script ran. What stopped it rebuilding his workspace inside a test
 * fixture is continuum's own `another_tmux_server_running_on_startup` — "is
 * another tmux of mine already up". On a fresh boot, on CI, or any evening his
 * tmux is down, that flips, and the file that started the only server on the
 * machine gets his sessions and his agent CLIs `--resume`d into it.
 *
 * The second file it found is the reason this lint is worth having rather than
 * being a note in a commit message. `tmux-tabs.test.ts` spawns no tmux at all —
 * it hands a `socket:` argv to `runAction` and `setStatusLine`, and `tmux()` in
 * tmuxctl.ts spawns the binary with it. A `set-option` on a socket with no
 * server does not fail, it STARTS one; that file made 394 calls into his
 * directory and ran continuum's restore too. Its header said it did not spawn
 * tmux, and by the letter it was right.
 *
 * WHAT THIS STILL CANNOT COVER, said plainly rather than left to be assumed:
 *
 *   - WHERE a socket lands, when the file names it with `-L` and no
 *     TMUX_TMPDIR. There are three doors — `process.env.TMUX_TMPDIR`, a
 *     `TMUX_TMPDIR:` in a child env, and an explicit `-S` — and the values go
 *     through `let` bindings and `mkdtempSync`, so deciding it from source
 *     means a regex that guesses. The second rule below covers the one door
 *     that IS a single syntactic form; the rest is what the recording tmux is
 *     for, and it answers in one run.
 *   - A file that redirects the PRODUCT's socket instead of its own —
 *     `chat-pane.test.ts` sets `AGENTGLASS_TMUX_SOCKET` and builds no argv, so
 *     it is not in the population below. Measured at two `list-sessions` in his
 *     directory, which start no server; fixed there, not here.
 *   - Two runs colliding. The second rule checks the SHAPE ce905fa measured,
 *     and shape is all source can see; whether two processes actually met is
 *     not a property of one file.
 *   - Ports. `freePort()` is the fix and eleven files use it, but a literal
 *     port and a computed one are not distinguishable here without failing
 *     every legitimate constant in the suite.
 */
describe("no test file runs tmux without isolating it", () => {
  // Same declared-absence rule as the lint above: `mobile/` is not in the
  // tree until the third branch of the release stack. See `lintFiles`.
  const roots: LintRoot[] = [
    { dir: "server/test", ext: ".test.ts" },
    { dir: "mobile/test", ext: ".test.ts", absentWithout: "mobile/package.json" },
  ];
  const repo = join(import.meta.dir, "..", "..");

  /**
   * A file that can cause a tmux server to exist.
   *
   * Three signals, and the third is the one that matters: `socket:` catches the
   * files that spawn nothing themselves and let `tmuxctl.ts` do it, which is
   * how `tmux-tabs.test.ts` read as innocent for as long as it did. Anchored on
   * the spawn and not on the word "tmux" — that same file passes `["tmux",
   * "-L", "work", …]` to `socketFromArgv` a dozen times as DATA, and counting
   * those would make this noise on its first day.
   */
  const runsTmux = (src: string): boolean =>
    /Bun\.spawn(?:Sync)?\(\s*\[\s*"tmux"/.test(src)
    || /execvp\('tmux'/.test(src)
    || /socket:\s*[[\w]/.test(src);

  /*
   * `-f /dev/null`, however it is spelt — spread from the shared constant,
   * written into the argv, or single-quoted inside the python pty helper four
   * files use.
   *
   * `...TMUX_ISOLATED` with the spread, never the bare name, and that is not
   * pedantry: the first version matched the identifier, so a file that still
   * IMPORTED the constant while no longer spreading it passed. Proved by
   * putting `const SOCK = ["-L", "agx-stale-test"]` back in tmux-stale and
   * watching this stay green — the exact defect this lint was written for,
   * unseen by the lint.
   */
  const readsNoConfig = (src: string): boolean =>
    /\.\.\.TMUX_ISOLATED|"-f",\s*"\/dev\/null"|'-f','\/dev\/null'/.test(src);

  /** Where `process.env.TMUX_TMPDIR` is pointed, if it is pointed anywhere: the
   *  initialiser of the constant assigned to it. Deliberately only this
   *  process's own variable. `TMUX_TEST_TMPDIR`, handed to a CHILD, is fixed on
   *  purpose — see tmuxTmp.ts: it stays empty, and a suite that puts a server
   *  in it names its own socket — so a rule that swept that up would be wrong.  */
  const tmpdirsSet = (src: string): string[] => {
    const decls = new Map<string, string>();
    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*(`[^`]*`|"[^"]*")/g)) decls.set(m[1]!, m[2]!);
    return [...src.matchAll(/process\.env\.TMUX_TMPDIR\s*=\s*(\w+)\b/g)]
      .map((m) => decls.get(m[1]!)).filter((v): v is string => v !== undefined);
  };

  const files = roots.flatMap((r) => lintFiles(repo, r).filter((f) => runsTmux(f.src)));

  test("every one of them starts its tmux with an empty configuration", () => {
    const offenders = files.filter((f) => !readsNoConfig(f.src)).map((f) => f.rel);
    expect(offenders, "these can start a tmux with no `-f`, so it reads ~/.tmux.conf — on this machine that loads tpm, tmux-resurrect and tmux-continuum with @continuum-restore on. Spread TMUX_ISOLATED into the argv (see server/test/tmuxIsolated.ts); a file that only builds a `socket:` for tmuxctl puts it there, because tmuxctl cannot add one — in production that config is the user's and loading it is the point").toEqual([]);
  });

  test("and the socket directory they name is their own, not shared", () => {
    // A FIXED private directory is not isolation from the run next door: both
    // runs get one server, and each one's `killServer` in `beforeAll` tears
    // down the other's fixture mid-assertion — measured at 3-8 tests apiece.
    // The socket NAME stays fixed on purpose; ce905fa measured that isolating
    // the name instead goes from 5 failures to 18, because the search hands
    // every server in a directory to `listPanes`.
    const offenders = files.flatMap((f) =>
      tmpdirsSet(f.src).filter((v) => !v.includes("process.pid")).map((v) => `${f.rel} → ${v}`));
    expect(offenders, "give the file a TMUX_TMPDIR carrying process.pid, and put the old value back in afterAll").toEqual([]);
  });

  test("the lint is looking at the files it thinks it is", () => {
    // The same guard-on-the-guard as above, and it earns its place: both files
    // this was written for match `runsTmux` today, and a detector that silently
    // stopped matching would leave the two tests above green over nothing.
    expect(files.map((f) => f.rel)).toContain("server/test/tmux-stale.test.ts");
    expect(files.map((f) => f.rel)).toContain("server/test/tmux-tabs.test.ts");
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  /*
   * A THIRD thing a suite must not inherit from the developer, alongside their
   * config and their socket directory: their TERMINAL.
   *
   * Six files fabricate a real client — a pty from `pty.fork()` or one
   * `script(1)` builds — because "tmux sizes a window to the client looking at
   * it" cannot be asked of a mock. None of them said what kind of terminal it
   * was, so TERM came from the shell that started `bun test`. That is
   * `xterm-256color` on this machine and `dumb` in a CI job step, and tmux
   * refuses `dumb` outright: "open terminal failed: terminal does not support
   * clear", exit 1, no client. 37 tests failed the first time these ran
   * anywhere but here, and not one of them named a terminal — they read as
   * "geom 200x50, expected 200x49" (the missing row is the status line, which
   * only exists once a client attaches) and as `attachArgvFor` returning null
   * (`listPanes` skips a server nobody is attached to).
   *
   * Its own file list, deliberately NOT `files` above: `runsTmux` looks for a
   * spawn of `tmux` itself, and two of the six reach tmux only through a spread
   * argv or through `tmuxctl.ts`, so they are not in it.
   */
  const buildsAClient = (src: string): boolean => /pty\.fork\(\)/.test(src) || /"script",\s*"-qf/.test(src);

  /*
   * The whole `Bun.spawn(...)` call, by walking parentheses from the opener.
   *
   * A regex cannot do this and the first attempt proved it: both client shapes
   * carry parentheses of their own — `struct.pack('HHHH',int(sys.argv[4]),…)`
   * inside the python source, and `built.argv.map((a) => …).join(" ")` inside
   * the `script` argv — so a non-greedy match to the first `})` stopped in the
   * middle of the argv and every spawn looked TERM-less. Depth counting is
   * safe here because every one of those parentheses is balanced.
   */
  const clientSpawns = (src: string): string[] => {
    const calls: string[] = [];
    for (const m of src.matchAll(/Bun\.spawn\(/g)) {
      const start = m.index!;
      let depth = 0, end = -1;
      for (let i = start + "Bun.spawn".length; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")" && --depth === 0) { end = i; break; }
      }
      if (end === -1) continue;
      const call = src.slice(start, end + 1);
      if (/\[\s*"(?:script|python3)"/.test(call)) calls.push(call);
    }
    return calls;
  };

  const clientFiles = roots.flatMap((r) => lintFiles(repo, r).filter((f) => buildsAClient(f.src)));

  /*
   * Whether a spawn declares a TERM, following ONE level of indirection.
   *
   * Most of these hand the env to a `clientEnv()` helper — the env has to be
   * built at call time, because `beforeAll` puts TMUX_TMPDIR into `process.env`
   * after the module is evaluated — so the literal `TERM` is in the helper and
   * not at the spawn. Resolving the identifier is the same trick `tmpdirsSet`
   * above uses, and the alternative is worse: a lint that accepted the mere
   * presence of `clientEnv` would go green on a file that kept the helper and
   * stopped passing it, which is the exact shape of the `TMUX_ISOLATED` near
   * miss recorded further up this file.
   */
  /*
   * Comments out, before anything is asked about the code.
   *
   * Measured while writing this: without it, the lint passed on a spawn whose
   * TERM had been deliberately deleted, because the sentence explaining WHY the
   * TERM was there ("tmux refuses TERM=dumb") was still four lines above and
   * fell inside the window being searched. A lint that a comment can satisfy is
   * worse than none — it is green precisely where somebody has been editing.
   */
  const decomment = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");

  const declaresTerm = (call: string, src: string): boolean => {
    const code = decomment(src), c = decomment(call);
    if (/\bTERM\b/.test(c)) return true;
    /*
     * Exactly two indirections are legitimate, and they are resolved by name
     * rather than by scanning nearby text — a window big enough to reach a
     * helper is also big enough to reach the next unrelated one.
     *
     *   env: clientEnv()          the env is built at call time, because
     *                             beforeAll writes TMUX_TMPDIR into process.env
     *                             after the module is evaluated
     *   ["python3", "-c", SRC…]   the TERM is set by the child itself, inside
     *                             the python source held in a const — which is
     *                             what mobile/test/pane-line.test.ts does, and
     *                             it had this right before any server file did
     */
    const refs = new Set<string>();
    const env = /env:\s*(\w+)\s*\(/.exec(c);
    if (env) refs.add(env[1]!);
    const argv = /\[\s*"(?:script|python3)"([\s\S]*?)\]/.exec(c);
    if (argv) for (const m of argv[1]!.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) refs.add(m[1]!);

    for (const r of refs) {
      // Bounded by the next top-level declaration, not by a character count.
      const def = new RegExp(`const\\s+${r}\\s*[:=]([\\s\\S]*?)(?=\\nconst |\\nfunction |\\ntest\\(|\\ndescribe\\(|$)`).exec(code);
      if (def && /\bTERM\b/.test(def[1]!)) return true;
    }
    return false;
  };

  test("and a client it fabricates says what kind of terminal it is", () => {
    const offenders = clientFiles.flatMap((f) =>
      clientSpawns(f.src).filter((c) => !declaresTerm(c, f.src))
        .map((c) => `${f.rel} → ${c.slice(0, 70).replace(/\s+/g, " ")}…`));
    expect(offenders, "a terminal emulator sets TERM, and a test that builds its own pty IS one. Put `TERM: TEST_TERM` in that spawn's env (see server/test/tmuxTerm.ts) — inheriting it means the suite passes here and cannot attach a client on a runner, where TERM is `dumb` and tmux refuses it").toEqual([]);
  });

  test("that lint is looking at the files it thinks it is", () => {
    // Same guard-on-the-guard as above, and it earns it twice over: the two
    // detectors are independent, so `clientSpawns` could silently match nothing
    // — which is exactly how a lint goes green over a defect it was written for.
    const rels = clientFiles.map((f) => f.rel);
    for (const n of ["tmux-attach", "tmux-shutdown-restore", "tmux-attach-claim",
                     "tmux-sigkill-restore", "tmux-focus-pane", "tmux-window-size"]) {
      expect(rels).toContain(`server/test/${n}.test.ts`);
    }
    // Eleven today: six pty/`script` helpers, one per file, plus the five
    // `script -qfec` phone clients tmux-attach.test.ts spawns inline.
    expect(clientFiles.flatMap((f) => clientSpawns(f.src)).length).toBeGreaterThanOrEqual(11);
  });
});
