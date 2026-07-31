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

export const claudeCode: PaneAgent = {
  id: "claude-code",
  label: "Claude Code",

  bin: () => Bun.which("claude"),

  missingReason: () =>
    "no local `claude` CLI: install Claude Code to chat (Settings ▸ Requirements lists it, with the install guide)",

  transcriptFor: (cwd, sessionId) =>
    join(claudeHome(), "projects", projectSlug(cwd), `${sessionId}.jsonl`),

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
