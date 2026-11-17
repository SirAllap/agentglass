/*
 * THE END OF AN INTERACTIVE CLAUDE TURN, read from the CLI's own transcript.
 *
 * A worker runs the real Claude Code TUI in its pane, so nothing on its stdout
 * says a turn is over: the CLI stays in the window, which is the point. The one
 * fact that ends a turn is the line the CLI writes itself — a `system` entry
 * with subtype `turn_duration` (`agents/claudecode.ts`, `isTurnEnd`) — and the
 * turn's answer is the assistant text after the last thing the person (or the
 * seat) said.
 *
 * So this watches the transcript file the app already reads for an interactive
 * tab (`chatpane.ts transcriptFor`), and when the turn's marker appears it
 * writes the turn's answer to the run folder's `out` and its status to `rc`,
 * the two files the wrapper would have written. Everything downstream —
 * `ceilings.ts` settling the row, `reportOf`, `endedWithoutResult` — then works
 * unchanged, because it only ever knew those two files.
 *
 * The seat is told at the marker, not when the CLI leaves: the turn is over and
 * the worker is waiting for its next one (`workerend.ts` `announceWorkerWaiting`),
 * and that notice is sent before the status is left so the settling that follows
 * does not announce the same turn as an ending.
 *
 * What this does NOT do: it does not see a queued prompt or a CLI that is
 * thinking. Those are the screen's and the hooks' (the Stop hook marks the
 * session waiting on a person); a turn that never writes its marker is a turn
 * the ceiling stops.
 *
 * ONE EXCEPTION, because a pane nobody is at can be stopped by a dialog forever:
 * a turn whose transcript has not grown for `TUI_STALL_MS` while the pane is
 * showing a prompt of its own is ended here, with an error naming it, instead of
 * sitting until the turn limit. The argv is built so that nothing asks
 * (`headless.ts`, `dontAsk`); this is the guard for what does not obey it — a
 * trust dialog in a directory the CLI has never seen, say.
 *
 * Ceiling: the marker is written by the CLI, so an engine whose transcript has
 * no such line cannot end a turn this way — that is why only Claude Code runs
 * as a TUI here and the others keep their headless forms.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { screenNeedsYou } from "../chatpane.ts";
import type { RunFiles } from "./headless.ts";
import { setIntervalAs } from "../loopwatch.ts";

/** How often the transcript is looked at. A turn is seconds to minutes, and
 *  one read of the bytes appended since the last look is cheap; a shorter
 *  clock would only make the card's "running" end sooner than a person can
 *  see it. */
export const TUI_POLL_MS = 1000;

/** How long the transcript may sit still before the pane is asked whether it is
 *  showing a dialog. That is what ends the turn: a long tool call writes its
 *  line when it returns, so stillness alone decides nothing. */
export const TUI_STALL_MS = 20_000;

/** The word the row reads when a dialog nobody can answer ended the turn. */
const STUCK = "waiting on a permission prompt nobody can answer (the pane is showing a dialog), so the turn was ended";

/** The bytes appended since `from`, or "" when the file is not there yet. */
function appended(path: string, from: number): { text: string; at: number } {
  if (!existsSync(path)) return { text: "", at: from };
  let size: number;
  try { size = statSync(path).size; } catch { return { text: "", at: from }; }
  if (size <= from) return { text: "", at: size < from ? size : from };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - from);
    const read = readSync(fd, buf, 0, buf.length, from);
    return { text: buf.subarray(0, read).toString("utf8"), at: from + read };
  } finally { closeSync(fd); }
}

/** Whether one line of a transcript is the CLI saying the turn is over. */
export function isTurnEndLine(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("{")) return false;
  try {
    const f = JSON.parse(t) as { type?: unknown; subtype?: unknown };
    return f.type === "system" && f.subtype === "turn_duration";
  } catch { return false; }
}

/**
 * The turn's answer: the assistant text after the last thing said TO the
 * model. A `user` line mid-turn is usually a tool result, which is not the
 * person speaking again — only a user line carrying text resets the answer.
 * Thinking and tool calls are not text and are not the answer.
 */
export function answerIn(lines: readonly string[]): string {
  const said: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let f: { type?: unknown; message?: { content?: unknown } };
    try { f = JSON.parse(t) as typeof f; } catch { continue; }
    const content = f.message?.content;
    if (f.type === "user") {
      if (Array.isArray(content) && content.some((b) => (b as { type?: unknown })?.type === "text")) said.length = 0;
      continue;
    }
    if (f.type !== "assistant" || !Array.isArray(content)) continue;
    for (const b of content) {
      const block = b as { type?: unknown; text?: unknown };
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) said.push(block.text);
    }
  }
  return said.join("\n\n");
}

/** Where the turn's end is looked for: the bytes this turn appended, and the
 *  answer they carry. Null until the marker is there. */
export function turnEndedIn(text: string): { answer: string } | null {
  const lines = text.split("\n");
  const at = lines.findIndex(isTurnEndLine);
  if (at < 0) return null;
  return { answer: answerIn(lines.slice(0, at)) };
}

/** Leave the turn's answer and its status where the wrapper would have. The
 *  status is moved in from `part/`, the one way the folder's watch sees it
 *  whole (`headless.ts`). */
export function leaveTuiResult(files: RunFiles, answer: string): void {
  writeFileSync(files.out, answer, { mode: 0o600 });
  const part = join(files.dir, "part", "rc");
  writeFileSync(part, "0\n");
  renameSync(part, files.rc);
}

/** Leave a turn that ended without an answer, and why. The status and the last
 *  line of `err` are what the wrapper would have left, so everything downstream
 *  reads it as the failed turn it is. */
export function leaveTuiError(files: RunFiles, why: string): void {
  writeFileSync(files.err, `${why}\n`, { mode: 0o600 });
  const part = join(files.dir, "part", "rc");
  writeFileSync(part, "1\n");
  renameSync(part, files.rc);
}

/**
 * Watch one interactive turn to its end. Returns the stop function; the
 * caller stops it when the turn is disarmed, because a name can be somebody
 * else's by then.
 *
 * `from` is the transcript's size when the turn was armed: a resumed session
 * already holds its earlier turns, and their markers must not end this one.
 *
 * `screen` is the pane's visible text. It is asked only when the transcript has
 * been still for `stallMs`, and a dialog on it ends the turn with an error
 * instead of leaving it to the ceiling.
 */
export function watchTuiTurn(o: {
  files: RunFiles; transcript: string; from?: number;
  /** How the answer is left. Injected so a suite needs no folder. */
  leave?: (files: RunFiles, answer: string) => void;
  /** How a turn that ended on a dialog is left. */
  leaveError?: (files: RunFiles, why: string) => void;
  /** The turn is over and the CLI is still in its pane: told before the status
   *  is left, so the seat hears "waiting" and not an ending (workerend.ts). */
  onTurnEnd?: () => void;
  /** The pane's visible text, or null when it is gone. */
  screen?: () => string | null | Promise<string | null>;
  /** How long a still transcript may be asked about. */
  stallMs?: number;
  pollMs?: number;
  onError?: (e: unknown) => void;
}): () => void {
  let at = o.from ?? 0;
  let buf = "";
  /* Every whole line this turn appended, kept across polls: a turn longer than
     one poll has its answer spread over several reads. */
  const lines: string[] = [];
  const leave = o.leave ?? leaveTuiResult;
  const leaveError = o.leaveError ?? leaveTuiError;
  const stallMs = o.stallMs ?? TUI_STALL_MS;
  let stopped = false;
  let still = Date.now();
  let asking = false;
  const stop = (): void => { stopped = true; clearInterval(timer); };
  const timer = setIntervalAs("tui turn watch", () => {
    if (stopped) return;
    try {
      const chunk = appended(o.transcript, at);
      at = chunk.at;
      if (!chunk.text) {
        /* Nothing written since the last look. That alone is not a stall — a
           tool call writes its line when it returns — so the screen decides. */
        if (!o.screen || asking || Date.now() - still < stallMs) return;
        asking = true;
        void Promise.resolve(o.screen()).then((screen) => {
          if (stopped) return;
          /* A working pane resets the window: asking again on the next tick
             cost a capture per second for the rest of a long `bun test`. */
          if (!screen || !screenNeedsYou(screen)) { still = Date.now(); return; }
          stop();
          leaveError(o.files, STUCK);
        }).catch((e) => o.onError?.(e)).finally(() => { asking = false; });
        return;
      }
      still = Date.now();
      buf += chunk.text;
      /* Only whole lines: a read can land in the middle of the last one, and
         half a marker is not a marker. */
      const cut = buf.lastIndexOf("\n");
      if (cut < 0) return;
      const fresh = buf.slice(0, cut + 1).split("\n").slice(0, -1);
      buf = buf.slice(cut + 1);
      lines.push(...fresh);
      if (!fresh.some(isTurnEndLine)) return;
      stop();
      const answer = answerIn(lines);
      try { o.onTurnEnd?.(); } catch (e) { o.onError?.(e); }
      leave(o.files, answer);
    } catch (e) { o.onError?.(e); }
  }, o.pollMs ?? TUI_POLL_MS);
  timer.unref?.();
  return stop;
}

/** The transcript's size now, for a watch that must not read the turns before
 *  this one. */
/** Where a turn's transcript started, kept in its run folder. The watch is in
 *  the server's memory, and one armed again after a restart from the size at
 *  that moment missed a marker the CLI wrote while the server was down: the
 *  worker then read "still on its turn" for good. */
const tuiFromPath = (files: RunFiles): string => join(files.dir, "tuifrom");
export function keepTuiFrom(files: RunFiles, from: number): void {
  try { writeFileSync(tuiFromPath(files), String(from)); } catch { /* no folder: the watch still runs */ }
}
/** The kept start, or null. The run folder is the worker's to write, so a
 *  value that is not a size is no start; one past the file only waits longer. */
export function tuiFromOf(files: RunFiles): number | null {
  try {
    const t = readFileSync(tuiFromPath(files), "utf8").trim();
    return /^\d+$/.test(t) ? Number(t) : null;
  } catch { return null; }
}

export function transcriptSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}
