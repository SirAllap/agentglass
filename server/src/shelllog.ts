/**
 * A shell command, filed as telemetry rather than as a wall of text.
 *
 * The cockpit's PTY was the one place work happened that produced nothing
 * measurable. Everything an agent does through Claude Code lands in `events`
 * and is charted, searched, and counted; everything it did in the shell was
 * scrollback.
 *
 * So a command goes into the same table, in the same shape. That is not a
 * shortcut — it is what the issue asks for, and it is what makes the feature
 * worth more than the sum of its parts: the live feed shows shell commands
 * beside tool calls, the latency pane ranks `bun test` against `Read`, search
 * finds the `git push` that failed last Tuesday, and the retention rollup keeps
 * it all for exactly as long as it keeps everything else. None of that had to
 * be built.
 *
 * `PostToolUse` / `PostToolUseFailure` are deliberately the event types. A
 * command is a tool call: it has a name, a duration, and it either worked or it
 * did not. Inventing a fourth kind of event would have left it out of every
 * pane that already answers those questions.
 */
import { insertEvent } from "./db.ts";

/** Longest command text kept whole. The rest is a payload, not a name. */
const MAX = 400;

export interface ShellRecord {
  /** Pairs the finish with the start, so the existing latency machinery can
   *  compute a duration instead of this module inventing its own. */
  id: string;
  command: string;
  /** The program, for grouping — see commandName(). */
  name: string;
  exit: number | null;
  duration_ms: number;
  cwd: string | null;
  at: number;
}

/**
 * Which session a shell command belongs to.
 *
 * Its own, and deliberately not the agent session that happens to be open: a
 * person typing in the terminal is not the agent, and folding the two together
 * would put commands somebody ran by hand into an agent's transcript and its
 * cost. One id per server run keeps the shell's work grouped and separate.
 */
const SESSION = `shell-${Math.random().toString(36).slice(2, 10)}`;

const base = (id: string, name: string, cwd: string | null) => ({
  source_app: "terminal",
  session_id: SESSION,
  event_id: null,
  tool_name: name || "shell",
  tool_use_id: id,
  agent_id: null,
  agent_type: null,
  model_name: null,
  usage: {},
  usage_is_cumulative: false,
  cost_cumulative: null,
  reported_cost_usd: null,
  chat: null as unknown[] | null,
  payloadBase: { cwd, project_path: cwd, cwd_path: cwd },
});

/**
 * The command started.
 *
 * A Pre as well as a Post, because that pair is how everything else in this app
 * gets a duration — `insertEvent` finds the Pre and subtracts. Emitting only
 * the finish would mean computing the duration here and then having no way to
 * hand it over, and it would leave a running command invisible until it ends,
 * which for a ten-minute build is exactly when somebody wants to see it. The
 * open-tool card picks this up for nothing.
 */
export function beginShellCommand(r: { id: string; command: string; name: string; cwd: string | null; at: number }): void {
  try {
    const b = base(r.id, r.name, r.cwd);
    insertEvent({
      ...b,
      hook_event_type: "PreToolUse",
      is_error: 0,
      error_text: null,
      summary: r.command.slice(0, MAX),
      timestamp: r.at,
      payload: { ...b.payloadBase, command: r.command.slice(0, MAX) },
    } as Parameters<typeof insertEvent>[0]);
  } catch { /* the command is running either way */ }
}

/** Never throws. This is called from the hot path of somebody's terminal, and
 *  losing a telemetry row is the lesser harm by a wide margin. */
export function recordShellCommand(r: ShellRecord): void {
  try {
    const failed = r.exit !== null && r.exit !== 0;
    insertEvent({
      ...base(r.id, r.name, r.cwd),
      // A command is a tool call, and saying so is what puts it in the latency
      // pane, the tool mix and the feed without any of them being changed.
      hook_event_type: failed ? "PostToolUseFailure" : "PostToolUse",
      is_error: failed ? 1 : 0,
      // The exit code, not a sentence about it. `exit 130` is somebody pressing
      // ^C and `exit 127` is a typo in a command name; a reader who knows the
      // difference should not have it flattened away.
      error_text: failed ? `exit ${r.exit}` : null,
      summary: r.command.slice(0, MAX),
      // Stamped at the finish, not the start: the pairing subtracts the Pre's
      // timestamp from this one, so a Post stamped when the command *began*
      // would report every command as instant.
      timestamp: r.at + r.duration_ms,
      payload: { command: r.command.slice(0, MAX), exit: r.exit, cwd: r.cwd, project_path: r.cwd, cwd_path: r.cwd },
    } as Parameters<typeof insertEvent>[0]);
  } catch { /* the command already ran; losing its row is not worth a throw */ }
}
