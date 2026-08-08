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
 * One fixed directory rather than one per suite: it is empty, it stays empty,
 * and a suite that puts a server in it names its own socket. Fixed also means a
 * crashed run leaves nothing to accumulate. Created here so a spawn can use it
 * without each caller remembering to mkdir.
 *
 * This is the same defence `TMUX_ISOLATED` (`-f /dev/null`) makes one layer
 * down: that one stops a test's tmux from loading the developer's config, this
 * one stops a test's server from finding the developer's tmux.
 */
import { mkdirSync } from "node:fs";

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
