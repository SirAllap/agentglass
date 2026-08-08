/*
 * The TMUX_TMPDIR every script-spawned server gets, and why a script needs one
 * at all.
 *
 * These scripts spawn `server/src/index.ts`. That is a server, and a server
 * talks to tmux: it runs the boot sweep at module scope, and it answers
 * `/panes` out of `tmuxSockets()` + `listPanes()`. Both resolve against
 * `$TMUX_TMPDIR/tmux-<uid>`, and with TMUX_TMPDIR unset that directory is
 * `/tmp/tmux-<uid>` — on this machine, 25 sockets, including the `default` one
 * holding the sessions somebody is working in right now.
 *
 * The guards inside the server did not cover this and could not. Both open with
 * `if (process.env.NODE_ENV !== "test")` — `blindTmuxBanned` returning false and
 * `tmuxSocketAllowed` returning true — and a script sets no NODE_ENV. Measured
 * with the exact environment `perfbudget.ts` handed its child, `$TMUX` cleared:
 *
 *   NODE_ENV = undefined   TMUX_TMPDIR = undefined
 *   socketPath([])  /tmp/tmux-1000/default      allowed([])  true
 *   tmuxSockets()   25 sockets, his default among them
 *
 * and against an isolated stand-in baited the way a killed run leaves a window
 * (`@agx-had-size latest` + `window-size manual`), that server really did
 * rewrite what it found: `swept: 1, window-size after: latest, mark after:
 * (empty)`.
 *
 * This is the same defence `server/test/tmuxTmp.ts` makes for the suite, and
 * the two are deliberately separate files: a script is not a test, imports
 * nothing from `server/test`, and must not start depending on a fixed shared
 * directory that a concurrent `bun test` also uses. Each run gets its own,
 * inside the scratch home the script already builds for its database, config
 * and cache — so it is removed with everything else and two runs never meet.
 *
 * It is ALSO not the only layer, on purpose: `tmuxctl.ts` now refuses any
 * socket outside a named TMUX_TMPDIR from `tmux()` itself, and the boot sweep
 * refuses any server this installation has no record of pinning on. This file
 * is the half a new script has to remember; those two are the halves it does
 * not. `server/test/tmux-test-isolation.test.ts` fails the build if a file that
 * spawns the server — under `scripts/` as well as the test roots — does not
 * call this.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A private socket directory for one run's server, created before it is handed
 * over — and LOUD when it cannot be, because the quiet version is measurably
 * worse than passing nothing.
 *
 * Measured on tmux 3.6a: a TMUX_TMPDIR whose directory is absent falls back to
 * `/tmp/tmux-<uid>` silently. So a helper that swallowed a failed mkdir and
 * returned the path anyway would hand every child a variable that reads as
 * isolation to every guard in the server while tmux quietly used his
 * directory — which is exactly the hole `server/test/tmuxTmp.ts` was fixed for
 * (its `catch {}` said "already there", a case `mkdirSync(…, {recursive:true})`
 * cannot reach; every exception it ever swallowed was a real failure).
 *
 * Throwing takes the script down at the point of the mistake. A soak, a perf
 * run or a screenshot is worth nothing next to writing into a live session, and
 * there is no safe way to continue from here.
 */
export function privateTmuxDir(home: string): string {
  const dir = join(home, "tmux");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(
      `cannot create ${dir} to use as TMUX_TMPDIR (${code ?? e}). ` +
      `Refusing to spawn the server without one: tmux falls back to /tmp/tmux-<uid> ` +
      `when TMUX_TMPDIR names a directory that is not there, which is the user's own ` +
      `socket directory.`,
      { cause: e },
    );
  }
  return dir;
}
