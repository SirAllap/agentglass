// Every git command this server runs, kept in a ring buffer.
//
// A web UI that stages, rebases and deletes branches on your behalf is a black
// box: you press a button and something happens to your repository, with no way
// to see what. lazygit's answer is a command log panel showing each git
// invocation as it runs, and it's the cheapest trust mechanism there is — it
// turns "I hope it did the right thing" into "I can see what it did", and makes
// a bug report a copy-paste instead of a description.
//
// Deliberately in-memory and bounded. This is a live view of the current
// session, not an audit trail — persisting it would mean writing every poll to
// disk forever, and the value is entirely in the last few minutes.

// The row shape is shared with the client — see GitLogEntry in shared/types.ts.
// `write` is what lets the panel default to showing only mutating commands:
// reads run on every poll and would bury the one line that actually mattered
// under a hundred `status` calls.
import type { GitLogEntry } from "../../shared/types.ts";
export type { GitLogEntry };

/**
 * Subcommands that can modify the repository, the index or the working tree.
 *
 * An allowlist of *writes* rather than a denylist of reads: a git subcommand we
 * haven't thought of is far more likely to be another read-only query than a
 * new way to mutate the repo, and the cost of the two mistakes isn't symmetric.
 * Mislabelling a read as a write adds a line of noise; mislabelling a write as
 * a read hides exactly the line the log exists to show.
 */
const WRITE_COMMANDS = new Set([
  "add", "am", "apply", "branch", "checkout", "cherry-pick", "clean", "commit",
  "fetch", "gc", "init", "merge", "mv", "prune", "pull", "push", "rebase",
  "remote", "reset", "restore", "revert", "rm", "stash", "switch", "tag",
  "update-ref", "worktree",
]);

/** The subcommand, skipping the leading `-c key=value` pairs callers use to set
 *  config for one invocation. */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") { i++; continue; }
    if (!args[i].startsWith("-")) return args[i];
  }
  return "";
}

export function isWrite(args: string[]): boolean {
  const sub = subcommand(args);
  // `stash list` and `remote -v` read; `stash push` and `remote add` write. The
  // subcommand alone isn't enough for the handful that do both.
  if (sub === "stash" || sub === "remote" || sub === "worktree" || sub === "branch" || sub === "tag") {
    const rest = args.slice(args.indexOf(sub) + 1).filter((a) => !a.startsWith("-"));
    if (rest.length === 0 || rest[0] === "list") return false;
  }
  return WRITE_COMMANDS.has(sub);
}

// A non-numeric AGENTGLASS_GITLOG_SIZE (a typo, an empty string) makes
// Number(...) NaN, and NaN is poison here: `NaN <= 0` is false so the disable
// guard never fires, and `ring.length > NaN` is false so the trim never fires —
// the activity log then grows without any bound at all, the opposite of what the
// variable is for. Fall back to the default when it isn't a finite number.
const rawCap = Number(process.env.AGENTGLASS_GITLOG_SIZE ?? 400);
const CAP = Number.isFinite(rawCap) ? rawCap : 400;
const ring: GitLogEntry[] = [];
let seq = 0;

export function record(cwd: string, args: string[], exitCode: number, ms: number, stderr = ""): void {
  if (CAP <= 0) return;
  const entry: GitLogEntry = {
    id: ++seq, at: Date.now(), cwd, args, exitCode, ms, write: isWrite(args),
  };
  if (exitCode !== 0) {
    const first = stderr.split("\n").find((l) => l.trim());
    if (first) entry.error = first.trim().slice(0, 300);
  }
  ring.push(entry);
  if (ring.length > CAP) ring.splice(0, ring.length - CAP);
}

/** Entries newer than `since` (an id). The client passes back the last id it
 *  saw and appends what comes back, so a poll returns only what it hasn't
 *  rendered. */
export function recent(since = 0, limit = 200): GitLogEntry[] {
  const n = Math.max(1, Math.min(1000, limit | 0));
  if (since > 0) {
    // The NEXT entries after `since`, oldest first — not the newest page. The
    // client advances `since` to the last id it receives, so returning the
    // newest `limit` would skip everything between `since` and that page and
    // lose it for good the moment `since` jumps past it (a burst that records
    // more than `limit` lines between two 1s polls does exactly that). Oldest
    // first with no gap: each poll picks up precisely where the last left off.
    return ring.filter((e) => e.id > since).slice(0, n);
  }
  // First load (no cursor yet): the most recent activity, newest page of the
  // ring — nobody opening the panel wants to start at the oldest line still held.
  return ring.slice(-n);
}
