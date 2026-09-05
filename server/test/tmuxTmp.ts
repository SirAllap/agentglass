/*
 * The TMUX_TMPDIR every test-spawned server gets, and why every one of them
 * needs one.
 *
 * `tmuxSockets()` lists `$TMUX_TMPDIR/tmux-<uid>`. With TMUX_TMPDIR unset that
 * is `/tmp/tmux-<uid>` — the developer's own socket directory, holding the
 * sessions they are working in right now. The boot sweep walks every socket in
 * that listing and, on any window carrying `@agx-had-size`, sends
 * `resize-window -A`, `set-option -w window-size` and `refresh-client`. A test
 * server is a server: it runs that sweep at module scope, before it answers
 * anything.
 *
 * `tmuxctl.ts` refuses the walk under NODE_ENV=test — but measured on Bun
 * 1.3.9, `bun test` puts NODE_ENV=test in the TEST process and it reaches a
 * child spawned with `env: {...process.env}` and NOT one spawned with a named
 * environment. Nearly every suite here spawns with a named environment, on
 * purpose (`bun test` shares one process across files, so `...process.env` is
 * whatever the suite before this one left behind). So those children need to be
 * told, and `tmux-test-isolation.test.ts` fails the build if one is not.
 *
 * One fixed directory rather than one per suite: a suite that puts a server in
 * it names its own socket, so they cannot collide. Created here so a spawn can
 * use it without each caller remembering to mkdir — and swept here, see below,
 * because a fixed directory is exactly the one that accumulates.
 *
 * This is the same defence `TMUX_ISOLATED` (`-f /dev/null`) makes one layer
 * down: that one stops a test's tmux from loading the developer's config, this
 * one stops a test's server from finding the developer's tmux.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const TMUX_TEST_TMPDIR = "/tmp/agx-test-tmux";

/*
 * Loud when the directory cannot be made, because the quiet version armed the
 * exact thing this file exists to prevent.
 *
 * This was `catch { }` with a comment reading "already there" — a case that
 * cannot reach a catch at all. Measured on Bun 1.3.9, `mkdirSync(p, {
 * recursive: true })`:
 *
 *   directory already exists  -> no throw          <- the case the comment named
 *   path exists as a FILE     -> throws EEXIST
 *   parent unwritable         -> throws EACCES
 *
 * So every exception that ever reached that catch was a real failure — a stale
 * root-owned /tmp/agx-test-tmux, a full disk, someone's /tmp sweeper — and it
 * was swallowed, after which this module exported the path regardless and every
 * spawned child was handed a TMUX_TMPDIR pointing at nothing.
 *
 * Which is worse than handing them none. Measured on tmux 3.6a, a TMUX_TMPDIR
 * whose directory is absent falls back to /tmp/tmux-<uid> silently, and the
 * guard in tmuxctl.ts used to read the variable's mere presence as isolation
 * and unlock itself: a suite that set nothing was refused, a suite that set
 * this and lost the directory was let through to his live server.
 *
 * Nothing here is swallowed, EEXIST included — that one means the path is
 * present but is NOT a directory, which tmux refuses outright ("couldn't create
 * directory … Not a directory"). Harmless, but it is not isolation, and this
 * file's whole job is to not let those two look alike. Throwing takes the suite
 * down at import, which is the right outcome: there is no safe way to run these
 * tests from here, and a red import is how that gets noticed instead of
 * discovered later on somebody's sessions.
 */
try {
  mkdirSync(TMUX_TEST_TMPDIR, { recursive: true, mode: 0o700 });
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  throw new Error(
    `cannot use ${TMUX_TEST_TMPDIR} as TMUX_TMPDIR (${code ?? e}). ` +
    `Refusing to export it: tmux falls back to /tmp/tmux-<uid> when TMUX_TMPDIR is absent, ` +
    `which is the developer's own socket directory.`,
    { cause: e },
  );
}

/**
 * Sockets of servers that are gone, removed.
 *
 * `kill-server` does NOT delete the socket file — measured on tmux 3.6a: a
 * server started and killed cleanly leaves its socket behind exactly as a
 * SIGKILLed one does. So this directory gains one file per suite run, forever,
 * and it had 323 of them when somebody finally counted: 297 from one test file
 * alone. Harmless individually; a directory nobody ever looks in that only
 * grows is the shape of the thing you find at 40,000.
 *
 * TWO CONDITIONS, because either alone is wrong:
 *
 *   old enough   A socket a second suite created moments ago belongs to a
 *                server that may still be starting, and a `list-sessions`
 *                against a server mid-boot can fail. An hour is far past any
 *                suite's own setup and far short of how long these pile up.
 *   and dead     An hour-old socket can still be a long-running server. Asked
 *                rather than assumed, and asked ONLY of what passed the first
 *                condition, so this costs one spawn per genuinely stale file
 *                rather than one per file in the directory.
 *
 * Never recursive and never the directory itself: the sweep is handed a
 * directory precisely so a test can give it one of its own instead.
 *
 * And the directory is NOT `TMUX_TEST_TMPDIR`. tmux puts its sockets in
 * `$TMUX_TMPDIR/tmux-<uid>`, one level down — the first draft of this swept the
 * parent, found nothing but that subdirectory, removed zero and looked exactly
 * like a sweep that had nothing to do.
 */
export function sweepDeadSockets(
  dir: string,
  o: { now?: number; minAgeMs?: number } = {},
): { removed: number; kept: number } {
  const now = o.now ?? Date.now();
  const minAgeMs = o.minAgeMs ?? 60 * 60_000;
  let removed = 0, kept = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return { removed: 0, kept: 0 }; }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isSocket() || now - st.mtimeMs < minAgeMs) { kept++; continue; }
      const alive = Bun.spawnSync(["tmux", "-f", "/dev/null", "-S", path, "list-sessions"],
        { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
      if (alive) { kept++; continue; }
      rmSync(path);
      removed++;
    } catch { kept++; /* vanished under us, or unreadable: not ours to force */ }
  }
  return { removed, kept };
}

/** Where tmux actually puts the sockets under a given TMUX_TMPDIR. */
export const socketDirUnder = (tmpdir: string): string =>
  join(tmpdir, `tmux-${typeof process.getuid === "function" ? process.getuid() : 0}`);

/* Swept at import, which is once per `bun test` process however many files ask
   for the path. Never throws: a directory that cannot be tidied is not a reason
   to fail a suite, unlike one that cannot be CREATED — see above. */
try { sweepDeadSockets(socketDirUnder(TMUX_TEST_TMPDIR)); } catch { /* best-effort */ }
