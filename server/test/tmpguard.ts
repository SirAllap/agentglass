/*
 * A run that leaves a scratch directory or a tmux socket behind fails.
 *
 * tmpsweep.ts removes what the run created and tmuxleak.ts names the sockets
 * that carry this run's pid; neither FAILS on what slips past them (a directory
 * a child process made, a fixed label, a path outside what mkdtemp handed out).
 * This one is the plain check at the end: list `os.tmpdir()` and the DEFAULT
 * tmux socket directory (`/tmp/tmux-<uid>`, the developer's own, whatever
 * TMUX_TMPDIR says) before the run, list them again after, and fail with the
 * names of every new `agx-*` / `agentglass-*` entry. Mirrors web/test/leak-guard.ts.
 *
 * Has to be the LAST preload: afterAll hooks run in registration order, and the
 * sweep must have run first or every directory it is about to remove would be
 * blamed.
 *
 * Scoped to this run (see RunScope in tmpguardDiff.ts): an entry born before the
 * run started, or named for another pid, is not blamed on it. CEILING: an entry
 * a parallel run made after this one started, with no pid in its name, still
 * shows up; a private TMPDIR (`export TMPDIR=$PWD/.vt`) removes the doubt. Set AGX_TMPGUARD=off to skip.
 *
 * An exit code, not a throw, for the reason tmuxleak.ts gives.
 */
import { afterAll } from "bun:test";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { HOUSE_NAME, leakedEntries } from "./tmpguardDiff.ts";

const fs = createRequire(import.meta.url)("node:fs") as { readdirSync: (p: string) => string[]; statSync: (p: string) => { birthtimeMs: number; ctimeMs: number } };

const WATCHED = [tmpdir(), `/tmp/tmux-${process.getuid?.() ?? 0}`];
const list = (dir: string): string[] => { try { return fs.readdirSync(dir); } catch { return []; } };
const startedAt = Date.now();
const bornAt = (p: string): number | null => { try { const st = fs.statSync(p); return st.birthtimeMs || st.ctimeMs; } catch { return null; } };
const before = new Map(WATCHED.map((d) => [d, list(d)]));

if (process.env.AGX_TMPGUARD !== "off") {
  afterAll(() => {
    const leaks = WATCHED.flatMap((d) => leakedEntries(before.get(d) ?? [], list(d), HOUSE_NAME, { startedAt, pid: process.pid, bornAt: (n) => bornAt(`${d}/${n}`) }).map((n) => `${d}/${n}`));
    if (!leaks.length) return;
    console.error(`\n[tmpguard] ${leaks.length} entr${leaks.length === 1 ? "y" : "ies"} left behind by this run:\n  ${leaks.join("\n  ")}\n` +
      "  Remove them in the test's afterAll (rmSync a scratch dir; tmux kill-server, then rm the socket).\n");
    process.exitCode = 1;
  });
}
