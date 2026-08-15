/**
 * Read the shell's markers out of the byte stream, without disturbing it.
 *
 * This sits beside the PTY pump rather than in it: every byte still goes to the
 * client exactly as it arrived. Nothing here rewrites, strips or reorders the
 * stream — xterm.js ignores an OSC it does not recognise, so the markers cost
 * the display nothing, and a parser that edited the bytes would be one bug away
 * from eating somebody's output.
 *
 * ## What makes this different from prompt scraping
 *
 * The thing the issue rejects is guessing where a command started by looking at
 * the text. That breaks the first time somebody customises PS1, and it is wrong
 * in ways nobody notices. Here the shell *says* so, in a sequence that exists
 * for exactly this, and the parser has one job: find the sequences.
 *
 * ## The two facts a chunked stream forces
 *
 * A pty hands over whatever the kernel had, which means a marker can arrive
 * split down the middle — `\x1b]133;` in one read and `D;0\x07` in the next.
 * So this is a small state machine over an accumulating tail rather than a
 * regex over each chunk, and the tail is capped: a stray `\x1b]` with no
 * terminator must not turn into an unbounded buffer of somebody's `yes`.
 */

/** A command, once the shell has told us it finished. */
export interface ShellCommand {
  /** Pairs this with the start that was reported when it began. */
  id: string;
  /** What was typed. Empty when the shell reported no command text. */
  command: string;
  /** Exit status. `null` when the shell reported one we could not read. */
  exit: number | null;
  /** ms between the output marker and the finish marker. */
  duration_ms: number;
  /** Where it ran, from OSC 7, when the shell said. */
  cwd: string | null;
  started_at: number;
}

/**
 * Longest partial sequence worth holding on to.
 *
 * A ceiling on memory, not a working limit — but it has to clear a real command
 * line by a wide margin, because a sequence that overruns it is abandoned and
 * the command inside it vanishes from the history entirely. That is the wrong
 * way round: a `curl` with an inline JSON body is exactly the sort of long line
 * somebody later wants to know failed. 64KB holds anything a person types and
 * still bounds a session having binary poured through it.
 */
const MAX_PENDING = 64 * 1024;
/** Longest command text kept. A `curl` with an inline payload is not a name. */
const MAX_COMMAND = 400;

const ESC = 0x1b, BEL = 0x07, BACKSLASH = 0x5c;

/**
 * One shell session's worth of state.
 *
 * Deliberately a class with a clock injected: duration is the whole point of
 * this feature, and a test that could not control time would have to assert
 * "greater than zero", which passes just as well when the timer is broken.
 */
export class ShellMarkers {
  private pending = "";
  private inOsc = false;
  private started = 0;
  private command = "";
  private cwd: string | null = null;
  private running = false;
  private seq = 0;

  /** Set when a command is in flight, so its start and its end can be paired. */
  private id = "";

  /**
   * `onStart` fires when the shell says a command began, `onCommand` when it
   * finishes. Two callbacks rather than one, because the rest of the telemetry
   * is built on a Pre/Post pair: emitting only the finish would mean computing
   * duration by hand here and leaving a running command invisible until it
   * ends — which for the long ones is exactly when you want to see it.
   */
  constructor(
    private readonly onCommand: (c: ShellCommand) => void,
    private readonly now: () => number = Date.now,
    private readonly onStart: (c: { id: string; command: string; cwd: string | null; at: number }) => void = () => {},
  ) {}

  /** Where the shell last said it was. Null until it says. */
  get directory(): string | null { return this.cwd; }
  /** True between a command starting and finishing — what #4's alternate-screen
   *  check could never answer, and what a "type this command" button wants. */
  get busy(): boolean { return this.running; }

  /**
   * Feed a chunk of pty output. Never throws: this runs on the hot path of
   * somebody's terminal, and a parser fault must not cost them the shell it is
   * measuring.
   */
  feed(bytes: Uint8Array): void {
    try { this.scan(bytes); } catch { this.reset(); }
  }

  private reset(): void {
    this.pending = "";
    this.inOsc = false;
  }

  private scan(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (!this.inOsc) {
        // An OSC opens with ESC ] — and the ESC may have been the last byte of
        // the previous chunk, which is what `pending === "\x1b"` remembers.
        if (b === ESC) { this.pending = "\x1b"; continue; }
        if (this.pending === "\x1b") {
          if (b === 0x5d /* ] */) { this.inOsc = true; this.pending = ""; }
          else this.pending = "";
        }
        continue;
      }
      // BEL terminates, and so does ST (ESC \) — both are in the wild, and a
      // parser that knew only one would silently ignore half the terminals.
      if (b === BEL) { this.done(this.pending); continue; }
      if (b === ESC) { this.pending += "\x1b"; continue; }
      if (b === BACKSLASH && this.pending.endsWith("\x1b")) {
        this.done(this.pending.slice(0, -1));
        continue;
      }
      this.pending += String.fromCharCode(b);
      // A sequence this long is not one of ours. Give up on it rather than
      // grow: an unterminated OSC in a stream of binary output is a memory
      // leak with a plausible cause.
      if (this.pending.length > MAX_PENDING) this.reset();
    }
  }

  private done(body: string): void {
    this.inOsc = false;
    this.pending = "";
    this.handle(body);
  }

  /** One completed OSC body, e.g. `133;D;1` or `7;file://host/path`. */
  private handle(body: string): void {
    const semi = body.indexOf(";");
    const code = semi === -1 ? body : body.slice(0, semi);
    const rest = semi === -1 ? "" : body.slice(semi + 1);

    if (code === "7") {
      // `file://host/path` — the host is not ours to trust or use, and a path
      // is percent-encoded because it travels in a URL.
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(rest);
      if (m) { try { this.cwd = decodeURIComponent(m[1]!); } catch { this.cwd = m[1]!; } }
      return;
    }

    if (code === "633") {
      // The command text. `E;<command>` — see shellmark.ts for why plain
      // OSC 133 is not enough on its own.
      if (rest.startsWith("E;")) this.command = rest.slice(2).slice(0, MAX_COMMAND);
      return;
    }

    if (code !== "133") return;

    const kind = rest.slice(0, 1);
    if (kind === "C") {
      // Output begins: the command is running now. Timed from here rather than
      // from the keystroke, because what somebody wants to know is how long the
      // machine took, not how long they spent typing.
      this.started = this.now();
      this.running = true;
      const command = this.command.trim();
      if (command) {
        this.id = `sh-${(this.seq++).toString(36)}-${this.started.toString(36)}`;
        this.onStart({ id: this.id, command, cwd: this.cwd, at: this.started });
      }
      return;
    }
    if (kind === "D") {
      if (!this.running) {
        // A finish with no start. The usual cause is an empty line — the user
        // pressed return at the prompt — and reporting that as a command that
        // ran in 0ms would fill the history with nothing.
        this.command = "";
        return;
      }
      this.running = false;
      const arg = rest.slice(2); // past "D;"
      const exit = /^-?\d+$/.test(arg) ? Number(arg) : null;
      const command = this.command.trim();
      this.command = "";
      // A command with no text is one the shell did not tell us about. It has a
      // duration and an exit code and nothing to call it, which is a row nobody
      // can act on, so it is dropped rather than shown as a blank line.
      if (!command) return;
      this.onCommand({
        id: this.id,
        command,
        exit,
        duration_ms: Math.max(0, this.now() - this.started),
        cwd: this.cwd,
        started_at: this.started,
      });
      return;
    }
    if (kind === "A" || kind === "B") {
      // Prompt boundaries. The panel does not need them for the record, but
      // they are what says "the shell is idle" — see `busy`.
      this.running = false;
    }
  }
}

/**
 * The name a command should be filed under.
 *
 * `git push --force origin main` is a `git` call, the same way a tool call is a
 * `Bash` call — so the tool-latency and tool-mix panes get shell commands
 * grouped the way they group everything else, rather than one bucket per
 * distinct command line. `sudo` and `env` are stripped because filing every
 * privileged command under "sudo" answers nothing.
 */
export function commandName(command: string): string {
  const words = command.trim().split(/\s+/);
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    // A leading assignment (`FOO=bar cmd`) is not the command either.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    if (w === "sudo" || w === "env" || w === "command" || w === "exec" || w === "time") { i++; continue; }
    break;
  }
  const head = words[i] ?? "";
  // A path is filed under its basename: `/usr/local/bin/bun` and `bun` are the
  // same thing and splitting them makes both look rarer than they are.
  return (head.split("/").pop() || head).slice(0, 60);
}
