/*
 * A test that starts a tmux server must not leave its socket in the real
 * socket directory.
 *
 * `-L <label>` with no private TMUX_TMPDIR lands in `/tmp/tmux-<uid>`, the
 * directory the developer's own sessions live in, and `kill-server` leaves the
 * file behind. Every one of those files was a blocking tmux spawn on each poll
 * of the app's pane routes until they learned to skip dead sockets, and they
 * accumulated by the hundred. The fix is a private TMUX_TMPDIR per file (see
 * tmuxTmp.ts); this is what notices when a new test forgets.
 *
 * Attribution is by name: an entry that appeared during this run AND carries
 * this process's pid as a whole number — the convention every live-tmux test
 * here uses for its label (`agx-orbit-${process.pid}`). Other checkouts run
 * their suites at the same time into the same directory, so "anything new"
 * would blame this run for theirs.
 *
 * CEILING: a fixed label (`-L agx-orbit`) or a socket made by a child process
 * under its own pid is not attributable and is not caught here.
 *
 * An exit code, not a throw, for the reason isolation.ts gives: a root
 * `afterAll` that throws stops the ones registered after it.
 */
import { afterAll } from "bun:test";
import { createRequire } from "node:module";

const fs = createRequire(import.meta.url)("node:fs") as { readdirSync: (p: string) => string[] };

const dir = `${process.env.TMUX_TMPDIR || "/tmp"}/tmux-${process.getuid?.() ?? 0}`;
const list = (): string[] => { try { return fs.readdirSync(dir); } catch { return []; } };
const before = new Set(list());
/** Which of `names` this run leaked. Exported so the rule can be asserted. */
export function leakedByThisRun(names: string[], seen: Set<string>, pid = process.pid): string[] {
  // Anchored on the house `-<pid>` separator, not any non-digit: a label
  // carrying the pid glued on by a dot or nothing (a concurrent run's own
  // naming, not ours) must not count just because it sits between two
  // non-digit characters.
  const mine = new RegExp(`(^|[^0-9])-${pid}([^0-9]|$)`);
  return names.filter((n) => !seen.has(n) && mine.test(n));
}

/*
 * And a server still running in this run's own directory at the end. The
 * preload after this one removes that directory, and a live server whose socket
 * path is gone cannot be reached by anything again: it runs until the machine
 * reboots. So it is stopped here, and named. Attribution is exact — the
 * directory carries this run's pid (tmuxTmp.ts). Registered before tmpsweep for
 * that reason.
 */
const ownDir = `/tmp/agx-test-tmux-${process.pid}/tmux-${process.getuid?.() ?? 0}`;
function stopOwnServers(): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(ownDir); } catch { return []; }
  return names.filter((n) => Bun.spawnSync(["tmux", "-f", "/dev/null", "-S", `${ownDir}/${n}`, "kill-server"],
    { stdout: "ignore", stderr: "ignore" }).exitCode === 0);
}

afterAll(() => {
  const running = stopOwnServers();
  if (running.length) {
    console.error(`\n[tmuxleak] ${running.length} tmux server(s) still running at the end of the run, now stopped:\n  ${running.join("\n  ")}\n` +
      "  kill-server in the suite's own afterAll.\n");
    process.exitCode = 1;
  }
  const leaked = leakedByThisRun(list(), before);
  if (!leaked.length) return;
  console.error(`\n[tmuxleak] ${leaked.length} tmux socket(s) left in ${dir} by this run:\n  ${leaked.join("\n  ")}\n` +
    "  Give the test a private TMUX_TMPDIR (test/tmuxTmp.ts) and kill-server before restoring it.\n");
  process.exitCode = 1;
});
