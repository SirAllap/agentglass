/**
 * What the pane engine needs from an agent, named.
 *
 * The engine (chatpane.ts) keeps one interactive CLI alive in a tmux pane and
 * renders the conversation from the structured transcript that CLI writes — not
 * from the screen. That is why a pane chat renders as a chat rather than as a
 * wall of terminal output, and it is the decision worth keeping.
 *
 * It also pinned the whole engine to one vendor's on-disk format. Four things
 * were Claude Code's specifically, spread through a 600-line file: where the
 * binary is, the path shape `~/.claude/projects/<slug>/<id>.jsonl`, the flags
 * that start or resume a session, and the line that means a turn is over.
 * Nothing else writes any of that, so "run another agent in a pane" could not
 * be attempted without first answering what, exactly, an agent has to provide.
 *
 * This is that answer. It is deliberately smaller than the file the engine
 * reads today:
 *
 *   * **a turn's events**, appended to a file as they happen, in the shape the
 *     browser's stream parser already understands — `assistant` / `user`
 *     entries carrying content blocks;
 *   * **a definite end of turn.** The load-bearing one. The engine is reliable
 *     precisely because the CLI writes an explicit marker; anything inferred
 *     from an idle screen or a stopped spinner is wrong exactly when a tool
 *     takes four minutes, which is the moment it matters most;
 *   * **usage**, where the source has it, so the cost frame stays measured
 *     rather than estimated.
 *
 * What is deliberately *not* here: reading the screen. The engine screen-reads
 * for one thing — deciding the TUI has finished drawing its input box — and
 * that boundary is the whole reason the rest of this is structured data. An
 * agent that could only be read by scraping is one this engine should decline
 * rather than accommodate, because doing so loses tool structure, thinking and
 * usage, and breaks on the next redraw.
 *
 * ---
 *
 * On adopting somebody else's protocol instead. Several agent CLIs are
 * converging on a common client protocol, and implementing one of those would
 * be the longer-lived move — it would make "a definite end of turn" their
 * contract to keep rather than ours to infer. That is a real question and it is
 * not answered here: this names the contract the existing engine already
 * depends on, so it is visible and testable in one place instead of diffuse.
 * Swapping the inside of it for a wire protocol later is a smaller change than
 * finding these four couplings again.
 */

/** How a turn is launched. `fresh` is the distinction that bites: a session id
 *  that has never run must be *started*, and one that has must be *resumed*.
 *  Getting it backwards is a hard error rather than a degradation. */
export interface LaunchSpec {
  sessionId: string;
  cwd: string;
  model: string;
  /** Empty means "leave the CLI's own setting alone". */
  effort: string;
  mode: string;
  /** No transcript yet, so this session has never produced a turn. */
  fresh: boolean;
}

export interface PaneAgent {
  /** Stable key, for a spec and for saying which agent a chat is running on. */
  id: string;
  /** What a person calls it. */
  label: string;

  /** The executable, or null when it is not on this machine. */
  bin(): string | null;

  /** Why it cannot be used, in the words the settings pane will show. Only ever
   *  read when `bin()` is null, so it can name the install path directly. */
  missingReason(): string;

  /**
   * Where this session's turn events will be appended, whether or not the file
   * exists yet.
   *
   * Computable up front, and that is a requirement rather than a convenience: a
   * brand-new session has no file until it answers something, and the turn has
   * to know where to watch before it sends anything.
   */
  transcriptFor(cwd: string, sessionId: string): string;

  /** The command that starts the CLI in the pane. */
  argv(spec: LaunchSpec): string[];

  /**
   * Whether this transcript entry means the turn is finished.
   *
   * Must be an explicit marker the agent itself wrote. A reader that returns
   * true on a guess turns a four-minute tool call into a turn that appears to
   * end halfway through it.
   */
  isTurnEnd(entry: Record<string, unknown>): boolean;

  /**
   * Which entry types are forwarded to the browser.
   *
   * A transcript carries more than a conversation — file-history snapshots,
   * attachment records, the CLI's own title guess. None of it means anything to
   * the chat renderer, and forwarding it would have the browser parsing shapes
   * nobody wrote a case for.
   */
  forwards(type: string): boolean;
}
