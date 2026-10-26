// Reading an interactive `claude` pane's screen.
//
// What is left of the tmux chat engine once the chat view is gone: the readers
// the orchestrator seat and the understudy use to tell a pane that is running
// from one that is waiting on a person, find the input box, and decide whether
// a pasted prompt was submitted. Screen scraping decides nothing about the
// conversation itself; the transcript (Claude Code's own JSONL) is the source
// for that.
import type { PaneAgent } from "./paneagent.ts";
import { claudeCode, projectSlug } from "./agents/claudecode.ts";
import { agentProvider, type ScreenFacet } from "../../shared/agentKinds.ts";

/**
 * Which agent this engine runs.
 *
 * One, today. The point of the indirection is not that there are two — it is
 * that the four things Claude Code's own format decides (where the binary is,
 * the transcript path, the launch flags, and the line that ends a turn) were
 * spread through this file, so "run something else in a pane" could not even be
 * costed. They are named in paneagent.ts and implemented in
 * agents/claudecode.ts, unchanged.
 */
const agent: PaneAgent = claudeCode;

/** Where this session's transcript will be, whether or not it exists yet. The
 *  path has to be computable up front: a brand-new session has no file until it
 *  has answered something, and the turn needs to know where to watch. */
export function transcriptFor(cwd: string, sessionId: string): string {
  return agent.transcriptFor(cwd, sessionId);
}

export { projectSlug };

/** Rows that look like the input box: the prompt glyph and whatever follows.
 *
 *  Deliberately global, because there is usually more than one. A submitted
 *  prompt stays on screen in the scrollback with the same leading glyph, so the
 *  FIRST match is history and only the LAST is the live box. Reading the first
 *  one made a turn that had already run and answered look like a prompt that was
 *  never accepted, and the engine reported failure on a successful turn. */
const INPUT_ROWS = /^❯(.*)$/gm;

/** Hint text the TUI draws *inside* the empty input box.
 *
 *  A hint sits on the box's own row, behind the box's own glyph, and is not one
 *  character the user typed — but it is not whitespace either, so a box showing
 *  one reads as "holding something" unless it is named here.
 *
 *  That distinction is load-bearing. When a turn is already running, a newly
 *  submitted prompt is QUEUED, and the box then hints `Press up to edit queued
 *  messages`. Read as content, that hint is text which is neither empty nor the
 *  prompt we pasted, which is precisely the signature of "a picker opened" — so
 *  a prompt the CLI had accepted was reported to the user as an interactive
 *  prompt it could not draw. Worse on the next turn: the hint was already there
 *  before the paste, so `waitPasted` returned it as though it were our text, and
 *  every Enter afterwards compared the hint against itself and looked swallowed.
 *  The turn pressed Enter into a live pane until it timed out and then reported
 *  that the pane would not accept the prompt. Both prompts had in fact been
 *  queued, and both ran. */
const BOX_HINTS: RegExp[] = [
  // Anchored at BOTH ends, and that is the whole design of this list: a hint is
  // the only thing on its row, while a prompt that merely starts the same way
  // carries on past it. Unanchored, `Try "` also matched a real prompt —
  // `Try "npm test" first, then look at the failures` — and a box holding one
  // read as empty, so waitPasted never saw the paste land and the turn was
  // reported as a pane that would not take it.
  /^\s*Try ".*"\s*$/,                           // an empty box in a fresh session
  /^\s*Press up to edit queued messages\s*$/,   // an empty box with prompts queued
];

/** What is typed in the live input box right now, or `null` if it is not on
 *  screen at all (the TUI redraws while a turn runs). Note the box renders its
 *  empty state with U+00A0, which `\s` covers, and its hinted states with the
 *  strings above — both of which are empty as far as this engine is concerned. */
export function inputBox(screen: string): string | null {
  let last: string | null = null;
  for (const m of screen.matchAll(INPUT_ROWS)) last = m[1];
  if (last !== null && BOX_HINTS.some((re) => re.test(last!))) return "";
  return last;
}

/** What happened to the prompt we submitted.
 *
 *  `sent` — the box emptied, the CLI took it and started on it.
 *  `queued` — the CLI took it but is busy, so it is holding it behind the turn
 *    already running. Accepted, not started; see QUEUED_RE.
 *  `diverted` — the box holds something that is not our prompt any more. In
 *    practice this means an interactive command opened a picker: `/model`,
 *    `/effort`, `/config` do not run a turn, they draw a menu.
 *  `stuck` — still our text, still not taken, out of time. */
type SubmitOutcome = "sent" | "queued" | "diverted" | "stuck";

// --- attachments ------------------------------------------------------------
// The `-p` engine hands images to the model as base64 blocks on stdin. An
// interactive CLI has no such channel, so an attachment is written to a file and
// its path goes into the prompt; Claude Code reads it with the `Read` tool.
// Verified end to end against a real screenshot. The visible difference is that
// the turn spends one tool call on it.

// --- the turn ---------------------------------------------------------------

/** The footer Claude Code draws under an interactive prompt.
 *
 *  `/model`, `/effort` and `/config` do not run a turn — they draw a picker and
 *  wait for arrow keys. Nothing is ever written to the transcript, so a turn
 *  waiting for it waits forever, which is exactly how this was reported: a chat
 *  stuck on `/effort` with no way out.
 *
 *  Matched on the picker's own key hints rather than its title, because those
 *  are shared by every picker and are what make it a prompt at all. Careful not
 *  to catch a running turn: that one says "esc to interrupt", which is a
 *  different string and deliberately not matched here. */
const NEEDS_YOU_RE = new RegExp(agentProvider("claude")!.screen!.needsYou);
/** The pane is showing a prompt of its own (a permission, a confirmation). */
export const screenNeedsYou = (screen: string): boolean => NEEDS_YOU_RE.test(screen);
export const __needsYou = screenNeedsYou;
export const __isRunning = (screen: string): boolean => RUNNING_RE.test(screen);

/** The CLI is holding prompts it has accepted but not started.
 *
 *  Typing while a turn is in flight does not interrupt it and does not fail:
 *  Claude Code queues the prompt, draws it in a box of pending messages, and
 *  runs it when the current turn ends. That is a third state next to "running"
 *  and "idle", and the engine had no name for it, so it read as both of the
 *  wrong ones — as a picker while submitting (see BOX_HINTS) and as an idle
 *  pane afterwards, which would have ended the turn eight seconds in.
 *
 *  Observed on a machine whose network dropped mid-turn: the CLI sat on
 *  `Unable to connect to API (ENOTIMP) · Retrying in 8s · attempt 5/10`, two
 *  prompts sent from the chat were queued behind it, and both were reported to
 *  the user as errors. Both had been accepted, and both ran once the network
 *  came back.
 *
 *  Matched on the input box's own hint rather than on the pending-message box,
 *  because the hint is one stable line of text and the box is a drawn frame
 *  whose contents are the user's own prompts. */
const QUEUED_RE = /Press up to edit queued messages/;
export const __isQueued = (screen: string): boolean => QUEUED_RE.test(screen);

/** The submit loop's decision for one observed frame, without the tmux round
 *  trip. Exported so the ordering that matters — picker before input box — is
 *  pinned by a test rather than by a comment. */
export function __submitVerdict(screen: string, pasted: string): SubmitOutcome | "retry" {
  if (NEEDS_YOU_RE.test(screen)) return "diverted";
  if (QUEUED_RE.test(screen)) return "queued";
  const box = inputBox(screen);
  if (!box?.trim()) return "sent";
  if (box.trim() !== pasted.trim()) return "diverted";
  return "retry";
}

/** A turn that is actually working says so. Used to tell "idle" apart from
 *  "thinking", which is the difference between ending a turn and abandoning it. */
const RUNNING_RE = new RegExp(agentProvider("claude")!.screen!.running, "i");
/** Exported for the named-agent verbs (agentops.ts): one regex, read by the
 *  chat, the clone and a script's `wait --until working` alike. */
export const __running = (screen: string): boolean => RUNNING_RE.test(screen);

/**
 * HOW ONE ENGINE'S SCREEN IS READ.
 *
 * Everything above is Claude Code's, and stays exactly that: a reader is the
 * same five questions asked of another engine's pane, built from its facet. The
 * chair of a project can be sat by an engine whose TUI draws its box and its
 * working line differently, and a wake is typed on the answers, so the answers
 * have to be that engine's. `null` is an engine nobody has captured: it has no
 * reader and the chair refuses it, rather than reading its screen with Claude's
 * patterns and typing into whatever that turns out to be.
 */
export interface ScreenReader {
  needsYou(screen: string): boolean;
  running(screen: string): boolean;
  queued(screen: string): boolean;
  inputBox(screen: string): string | null;
  /** The box is on screen AND empty (nothing typed, or only its hint). Absent:
   *  any box counts, as Claude's always has. */
  blank?(screen: string): boolean;
  submitVerdict(screen: string, pasted: string): SubmitOutcome | "retry";
}

const CLAUDE_READER: ScreenReader = {
  needsYou: screenNeedsYou, running: __running, queued: __isQueued,
  inputBox, submitVerdict: __submitVerdict,
};

function readerFromFacet(f: ScreenFacet): ScreenReader | null {
  if (!f.inputBox) return null;
  const needs = new RegExp(f.needsYou), run = new RegExp(f.running, "i");
  const rows = new RegExp(f.inputBox, "gm");
  const hint = f.hint ? new RegExp(f.hint) : null;
  const starting = f.starting ? new RegExp(f.starting) : null;
  const box = (screen: string): string | null => {
    /* A dialog in front of the box: whatever box is drawn behind it is not one
       a paste can land in. */
    if (starting?.test(screen)) return null;
    let last: string | null = null;
    for (const m of screen.matchAll(rows)) last = m[1] ?? "";
    if (last !== null && hint?.test(last)) return "";
    return last;
  };
  return {
    needsYou: (s) => needs.test(s),
    running: (s) => run.test(s),
    /* None of the captured TUIs queues a prompt typed mid-turn in a way that
       has been seen; a queued state is added with the screen that shows it. */
    queued: () => false,
    inputBox: box,
    blank: (s) => box(s)?.trim() === "",
    submitVerdict(screen, pasted) {
      if (needs.test(screen)) return "diverted";
      const b = box(screen);
      if (!b?.trim()) return "sent";
      if (b.trim() !== pasted.trim()) return "diverted";
      return "retry";
    },
  };
}

const READERS = new Map<string, ScreenReader | null>();
/** The reader for one engine's chair or agent; no kind means Claude Code's. */
export function screenReaderFor(kind = "claude"): ScreenReader | null {
  if (kind === "claude") return CLAUDE_READER;
  if (!READERS.has(kind)) {
    const f = agentProvider(kind)?.screen;
    READERS.set(kind, f ? readerFromFacet(f) : null);
  }
  return READERS.get(kind) ?? null;
}

