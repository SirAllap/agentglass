import { homedir } from "node:os";
import { join } from "node:path";
import type { LaunchSpec, PaneAgent } from "../paneagent.ts";

/**
 * Claude Code, as a pane agent.
 *
 * Everything here was inline in chatpane.ts and is moved unchanged — the paths,
 * the flags and the end-of-turn marker are all verified against a real session
 * rather than inferred, and this file exists to hold them in one place rather
 * than to improve them.
 *
 * It is also the reference for what a second agent has to supply. Reading it
 * top to bottom is the shortest description of the contract in paneagent.ts.
 */

/** Where Claude Code keeps its transcripts. `CLAUDE_CONFIG_DIR` is the CLI's own
 *  knob and is honoured for the same reason it exists; the agentglass override
 *  is so tests can point at a fixture instead of a developer's real history. */
export function claudeHome(): string {
  return process.env.AGENTGLASS_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * The directory name Claude Code derives from a working directory.
 *
 * Every character that is not a letter or a digit becomes `-`, which is why a
 * path like `/home/x/code/app/.claude/wt` lands in `-home-x-code-app--claude-wt`
 * (the separator and the leading dot each contribute one). Verified against a
 * real session rather than inferred.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Does the installed CLI take `--name`?
 *
 * Asked of the binary rather than assumed, because the answer is a property of
 * whatever version happens to be on this machine and getting it wrong is not a
 * missing feature — an unknown flag makes the CLI exit before it starts, so a
 * tmux window would open, print a usage error and close. A capability check
 * costs one `--help` per process; a wrong guess costs the window.
 *
 * Cached for the life of the process. Somebody who upgrades the CLI mid-session
 * gets the old answer until the app restarts, which is the right trade against
 * running `--help` on every hand-off.
 */
let namesSessions: boolean | null = null;
export function supportsSessionName(bin: string | null): boolean {
  if (namesSessions !== null) return namesSessions;
  namesSessions = false;
  if (!bin) return false;
  try {
    const r = Bun.spawnSync([bin, "--help"], { stdout: "pipe", stderr: "pipe" });
    // `-n, --name <name>` in the options list. Matched on the long form only:
    // `-n` alone is too short to look for in a page of help text.
    namesSessions = /--name\b/.test(r.stdout.toString() + r.stderr.toString());
  } catch { /* an unreadable binary is one that does not take the flag */ }
  return namesSessions;
}

/** For a suite that needs to ask twice. */
export function __resetNameSupport(): void { namesSessions = null; }

export const claudeCode: PaneAgent = {
  id: "claude-code",
  label: "Claude Code",

  bin: () => Bun.which("claude"),

  missingReason: () =>
    "no local `claude` CLI: install Claude Code to chat (Settings ▸ Requirements lists it, with the install guide)",

  /* `home` overrides where to look, for a caller that launched the CLI with a
     CLAUDE_CONFIG_DIR of its own. Without it the server would go on reading
     ~/.claude/projects while the agent wrote its transcript somewhere else,
     and the turn would never be seen to end. */
  transcriptFor: (cwd, sessionId, home) =>
    join(home || claudeHome(), "projects", projectSlug(cwd), `${sessionId}.jsonl`),

  argv(spec: LaunchSpec): string[] {
    const bin = this.bin();
    const argv = [bin ?? "claude", "--model", spec.model];
    if (spec.effort) argv.push("--effort", spec.effort);
    // The distinction that matters: a session id that has never run must be
    // started with `--session-id`, and one that has must be started with
    // `--resume`. Reusing `--session-id` on an existing session is a hard error
    // ("Session ID is already in use"), so getting this backwards does not
    // degrade, it fails the turn.
    if (spec.fresh) argv.push("--session-id", spec.sessionId);
    else argv.push("--resume", spec.sessionId);
    /*
     * NO SUBAGENTS for an unattended run.
     *
     * Measured across a day: two whole shifts produced nothing because the run
     * delegated and then waited. Its own words, both times: "I'll wait for the
     * Explore agent's findings before writing the scope doc", then "I'll wait
     * for the notifications now instead of polling further" — and the clock
     * ran out with no file written and the suite green, because a run that
     * changes nothing has a green suite.
     *
     * Delegating is good advice for somebody who can see the delegate come
     * back. Nobody is watching this one, and it has no way to give up on a
     * subagent that never returns. A line in the brief telling it to budget
     * for the delegation was added after the first shift and did not survive
     * the second, which is how you learn that a rule is not a mechanism.
     *
     * Only for `unattended`, so the chats he is sitting in front of keep the
     * tool — there, a subagent that stalls is a thing he can see and stop.
     */
    if (spec.unattended) argv.push("--disallowed-tools", "Task");
    if (spec.mode === "bypassPermissions") argv.push("--dangerously-skip-permissions");
    else argv.push("--permission-mode", spec.mode);
    return argv;
  },

  /** Deterministic and written by the CLI itself: every completed turn's last
   *  transcript line is a `system` entry with subtype `turn_duration`. This is
   *  why the engine never has to guess from a spinner or an idle screen. */
  isTurnEnd: (o) => o.type === "system" && o.subtype === "turn_duration",

  /** A transcript carries a great deal that is not the conversation — file
   *  history snapshots, attachment records, the CLI's own title guess. */
  forwards: (type) => type === "assistant" || type === "user",
};
