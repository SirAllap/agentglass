/*
 * A container's log, as a running feed rather than a picture taken every three
 * seconds.
 *
 * The polling version had two failures and only one of them was visible. Cost
 * was the visible one — the whole tail, refetched forever, on a timer. The
 * quiet one is that anything printed between two polls beyond the tail window
 * was simply gone, so the busiest containers were the ones whose logs you could
 * least trust.
 *
 * What lives here is everything about that feed that is worth testing without a
 * daemon: where a chunk boundary falls, what "pause" means, how much is kept,
 * and what the viewer is told when the stream ends. The transport itself is one
 * injected function, so a test needs no server and the component needs no
 * knowledge of how bytes arrive.
 */

export interface LogFeed {
  /** The lines held right now, oldest first, already capped. */
  lines(): string[];
  /** Why the feed ended, or null while it is running. Never silence: a viewer
   *  that stops updating with no reason reads as a frozen panel. */
  ended(): string | null;
  paused(): boolean;
  pause(): void;
  /** Resume, and hand over everything that arrived while paused. */
  resume(): void;
  /** How many lines arrived while paused — what the "resume" button counts. */
  waiting(): number;
  close(): void;
}

export interface LogFeedOptions {
  /** Opens the transport. Returns the byte stream, or a reason it could not. */
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | { error: string }>;
  /** Called whenever the visible lines change. */
  onChange: () => void;
  /**
   * How many lines are kept.
   *
   * A cap, not a choice about history: a container printing a megabyte a second
   * must not be able to grow this tab until the window dies. Five thousand
   * lines is far past what anyone scrolls back through by hand and is about
   * half a megabyte of text.
   */
  cap?: number;
}

const DEFAULT_CAP = 5000;

/** Strip ANSI CSI/OSC — the same rule the panel used on the polled text, kept
 *  here so a streamed line and a polled one read identically. */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g; // eslint-disable-line no-control-regex

export function createLogFeed({ open, onChange, cap = DEFAULT_CAP }: LogFeedOptions): LogFeed {
  const controller = new AbortController();
  let lines: string[] = [];
  /** Lines that arrived while paused. Kept apart rather than dropped: pausing
   *  is for reading, not for missing what happened while you read. */
  let held: string[] = [];
  let partial = "";
  let paused = false;
  let end: string | null = null;
  let closed = false;

  const push = (text: string) => {
    const target = paused ? held : lines;
    target.push(text);
    // Trimming both buffers keeps the promise the cap makes even for someone
    // who pauses and walks away for an hour.
    if (target.length > cap) target.splice(0, target.length - cap);
  };

  const feed = (chunk: string) => {
    // A chunk is bytes off a socket, not a line: it can end mid-word, and the
    // rest of that word arrives next time. Joining is the whole reason this is
    // not `split("\n")` at the call site.
    const text = partial + chunk.replace(ANSI, "");
    const parts = text.split("\n");
    partial = parts.pop() ?? "";
    for (const line of parts) push(line);
    if (!paused && parts.length) onChange();
  };

  void (async () => {
    let stream: ReadableStream<Uint8Array> | { error: string };
    try {
      stream = await open(controller.signal);
    } catch (e) {
      end = String(e);
      onChange();
      return;
    }
    if (!(stream instanceof ReadableStream)) {
      end = stream.error;
      onChange();
      return;
    }
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        if (value) feed(dec.decode(value, { stream: true }));
      }
    } catch (e) {
      // An aborted read is the tab closing, which is not an error to report.
      if (!closed) end = String(e);
    }
    if (partial) { push(partial); partial = ""; }
    if (!closed && !end) end = "the stream ended";
    onChange();
  })();

  return {
    lines: () => lines,
    ended: () => end,
    paused: () => paused,
    waiting: () => held.length,
    pause() {
      if (paused || closed) return;
      paused = true;
      onChange();
    },
    resume() {
      if (!paused) return;
      paused = false;
      if (held.length) {
        lines = lines.concat(held);
        if (lines.length > cap) lines.splice(0, lines.length - cap);
        held = [];
      }
      onChange();
    },
    close() {
      if (closed) return;
      closed = true;
      controller.abort();
    },
  };
}

/* -------------------------------------------------------------------------
 * Reading a log, once it is on screen.
 * ---------------------------------------------------------------------- */

export type LogLevel = "error" | "warn" | "info" | "debug" | null;

/** What a line is, by the words logs actually use. A level pass, not a parser:
 *  severity and time are the structure that matters in a log. */
export function levelOf(line: string): LogLevel {
  if (/\b(ERROR|ERR|FATAL|CRITICAL|PANIC|Traceback|Exception)\b/.test(line)) return "error";
  if (/\b(WARN|WARNING|DeprecationWarning|FutureWarning)\b/.test(line)) return "warn";
  if (/\b(INFO|NOTICE)\b/.test(line)) return "info";
  if (/\b(DEBUG|TRACE)\b/.test(line)) return "debug";
  return null;
}

/**
 * The lines a viewer should see, given a minimum level and a search.
 *
 * "At least this level" rather than "exactly": somebody filtering to warnings
 * wants the errors too, and a filter that hides the worse thing is a trap.
 * Lines with no recognisable level survive every filter except the search —
 * dropping them would hide a stack trace's own body, which carries no level at
 * all and is the part you came for.
 */
const RANK: Record<Exclude<LogLevel, null>, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function filterLines(lines: string[], min: Exclude<LogLevel, null> | null, needle: string): string[] {
  const q = needle.trim().toLowerCase();
  if (!min && !q) return lines;
  return lines.filter((l) => {
    if (q && !l.toLowerCase().includes(q)) return false;
    if (!min) return true;
    const lvl = levelOf(l);
    return lvl === null ? false : RANK[lvl] >= RANK[min];
  });
}
