// The tmux-pane chat engine.
//
// The other engine (chat.ts) spawns `claude -p` per turn and streams its stdout.
// That is simple and stateless, and it pays for both: every turn re-initialises
// the whole session, which on a machine with MCP servers wired up measured 2.9-3.8s
// before the model said a word. This engine keeps one interactive `claude` alive
// in a tmux pane per chat, so that cost is paid once. Measured on the same
// prompt, model and directory: 2927/3766/3541ms via `-p`, 1354/1218/1431ms here.
//
// It does NOT read the screen to build the conversation. Claude Code writes a
// structured JSONL transcript for every session, which is the same source the
// dashboard already hydrates historical sessions from; the pane is where the
// process lives, the transcript is what it said. Screen scraping is used for
// exactly one thing — deciding the TUI has finished drawing its input box — and
// nothing about the conversation depends on it.
//
// The payoff beyond latency: the session is a real tmux session, so
// `tmux -L agentglass attach -t <id>` drops the user into the very chat they
// were reading in the app and lets them keep typing. That is not something the
// `-p` engine can ever offer.
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { PaneAgent } from "./paneagent.ts";
import { claudeCode, claudeHome, projectSlug } from "./agents/claudecode.ts";
import { stat } from "node:fs/promises";
import { costUsd } from "./pricing.ts";
import {
  paneAlive, startPane, killPane, pasteText, submit, interrupt, capture,
  touchPane, forgetPane, tmuxCapability, validPaneName, attachCommand,
} from "./tmuxpane.ts";
import { sealSituation, recordDecision, enabled as understudyEnabled, ATTACH_WINDOW_MS } from "./understudy.ts";
import { predictSealed } from "./understudy-predict.ts";

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

/** Size of a file, or 0 when it does not exist.
 *
 *  This is the turn's watermark. Reading only what is appended after it is what
 *  keeps a turn from replaying the whole conversation into the browser. */
async function sizeOf(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

// What we launched each pane with. A chat that changes model or permission mode
// mid-conversation cannot be honoured by an already-running CLI — both are
// process-level here — so the pane is taken down and brought back resumed,
// which costs one slow turn and keeps the conversation intact.
interface PaneSpec { model: string; mode: string; effort: string; cwd: string }
const specs = new Map<string, PaneSpec>();

/** How long to wait for the TUI to draw its input box before giving up.
 *
 *  Measured cold start is ~5s on a machine with several MCP servers; the ceiling
 *  is generous because the failure it guards against (a `claude` waiting for a
 *  login it can never receive) is indistinguishable from a slow start until the
 *  time is up. */
const READY_TIMEOUT_MS = Number(process.env.AGENTGLASS_PANE_READY_TIMEOUT_MS ?? 45_000);

/** The TUI's input box, as it appears once the session is ready for typing.
 *
 *  This is the one screen-scrape in the engine. It decides *when to type*, never
 *  *what was said* — if the marker ever changes the symptom is a turn that
 *  reports the pane never became ready, not a mangled conversation. */
const READY_RE = /❯|Try "/;

/** How long the pasted prompt may take to appear in the input box. Generous for
 *  what is a local terminal write, and bounded because the alternative to
 *  giving up is a turn that hangs forever on a prompt nobody submitted. */
const PASTE_TIMEOUT_MS = Number(process.env.AGENTGLASS_PANE_PASTE_TIMEOUT_MS ?? 10_000);

async function waitReady(name: string, deadline: number): Promise<boolean> {
  for (;;) {
    const screen = await capture(name);
    if (READY_RE.test(screen)) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(150);
  }
}

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

/** Wait until the pasted text is actually sitting in the input box.
 *
 *  Pressing Enter straight after `paste-buffer` loses the turn, and silently:
 *  the bracketed-paste terminator and the carriage return arrive in the same
 *  read, so the TUI treats the Enter as trailing content of the paste rather
 *  than as submit. The prompt then sits in the box forever and the turn waits on
 *  a transcript that will never grow — which is exactly how it failed the first
 *  time this ran end to end.
 *
 *  Polling the box rather than sleeping a magic number: the wait is over when
 *  the thing we are waiting for has happened, on a fast machine and a slow one
 *  alike. */
async function waitPasted(name: string, deadline: number): Promise<string | null> {
  for (;;) {
    const box = inputBox(await capture(name));
    // Returned rather than merely confirmed: what the box looks like holding
    // our prompt is the reference submitConfirmed compares against, and it is
    // not always the prompt itself — a multi-line paste renders as
    // "[Pasted text #1 +3 lines]".
    if (box?.trim()) return box;
    if (Date.now() > deadline) return null;
    await Bun.sleep(60);
  }
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

/** Press Enter until the prompt is actually accepted.
 *
 *  The first Enter after a paste is not merely late, it is *lost* — measured:
 *  the prompt sat in the box unchanged for a full 10s of polling, and a second
 *  Enter submitted it immediately. Best guess is that the terminator of the
 *  bracketed paste and the carriage return land in one read and the TUI folds
 *  the return into the paste.
 *
 *  So the send is confirmed rather than assumed: press, look, press again. An
 *  Enter on an already-empty box is a no-op in the TUI, which is what makes the
 *  retry safe — the worst case of racing a submit that did land is a keystroke
 *  that does nothing. A fixed sleep was the alternative and it would have been a
 *  guess that silently drops turns on a slower machine. */
async function submitConfirmed(name: string, pasted: string, deadline: number): Promise<SubmitOutcome> {
  for (;;) {
    await submit(name);
    // Long enough for the TUI to redraw after accepting. Deliberately generous:
    // the cost of waiting is a slower turn, the cost of looking too early is a
    // second Enter, and those two are not the same size at all — see below.
    await Bun.sleep(600);
    const screen = await capture(name);
    /*
     * A picker on screen means the prompt was ACCEPTED and opened something.
     * Never press again.
     *
     * This check has to come before the box check, and that ordering is the
     * whole fix. `/model` and `/effort` open a menu in which Enter means "set
     * as default" — it writes to the user's real settings.json. The previous
     * version looked only at the input box, and a capture taken 250ms after
     * Enter could still show the frame from before the menu drew: box still
     * holds "/effort", so it pressed Enter again, and that second press
     * confirmed the menu. It changed a real machine's saved effort from `high`
     * to `xhigh` twice before anyone noticed, once from a chat that looked like
     * it was simply thinking.
     */
    if (NEEDS_YOU_RE.test(screen)) return "diverted";
    // Also before the box check, and for the same reason: a queued prompt has
    // been ACCEPTED. Pressing again would not resend it — it would append
    // another copy of it to the queue.
    if (QUEUED_RE.test(screen)) return "queued";
    const box = inputBox(screen);
    if (!box?.trim()) return "sent";
    // Still our text, nothing opened: the Enter really was swallowed (the TUI
    // folds the first one into the bracketed paste). Safe to press again.
    if (box.trim() !== pasted.trim()) return "diverted";
    if (Date.now() > deadline) return "stuck";
  }
}

/** Ensure a live pane for this session, launching or relaunching as needed.
 *
 *  Whether the session has ever run is decided here — an empty transcript means
 *  it has not — and handed to the agent as `fresh`. What that turns into on the
 *  command line is the agent's business, and it is not a detail to get wrong:
 *  see agents/claudecode.ts, where getting it backwards fails the turn outright
 *  rather than degrading. */
async function ensurePane(
  sessionId: string, cwd: string, model: string, mode: string, effort: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!agent.bin()) return { ok: false, error: agent.missingReason() };

  const alive = await paneAlive(sessionId);
  const spec = specs.get(sessionId);
  // A live pane whose model or mode no longer matches what the chat is asking
  // for cannot be re-flagged in place; take it down and bring it back resumed.
  if (alive && spec && (spec.model !== model || spec.mode !== mode || spec.effort !== effort)) {
    await killPane(sessionId);
    specs.delete(sessionId);
  } else if (alive) {
    touchPane(sessionId);
    return { ok: true };
  }

  const fresh = (await sizeOf(transcriptFor(cwd, sessionId))) === 0;
  const argv = agent.argv({ sessionId, cwd, model, effort, mode, fresh });

  const started = await startPane(sessionId, cwd, argv);
  if (!started.ok) return { ok: false, error: started.stderr.trim() || "could not start the tmux pane" };

  if (!(await waitReady(sessionId, Date.now() + READY_TIMEOUT_MS))) {
    // Hand back what the pane is actually showing. When this fires it is almost
    // always a login prompt or an unaccepted agreement, and the screen says so
    // far better than any sentence written here in advance could.
    const screen = (await capture(sessionId)).trim().split("\n").filter(Boolean).slice(-6).join("\n");
    return { ok: false, error: `the chat pane never became ready in ${Math.round(READY_TIMEOUT_MS / 1000)}s.\n${screen}` };
  }
  specs.set(sessionId, { model, mode, effort, cwd });
  touchPane(sessionId);
  return { ok: true };
}

// --- attachments ------------------------------------------------------------
// The `-p` engine hands images to the model as base64 blocks on stdin. An
// interactive CLI has no such channel, so an attachment is written to a file and
// its path goes into the prompt; Claude Code reads it with the `Read` tool.
// Verified end to end against a real screenshot. The visible difference is that
// the turn spends one tool call on it.

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
};

/**
 * Where a turn's images are written before their paths go into the prompt.
 *
 * Under Claude Code's home, which is where it has always been — but note this
 * is *not* part of the agent contract. Any CLI can read any path; the directory
 * only has to exist and be readable. It is imported directly rather than added
 * to `PaneAgent` so the interface stays the four things that genuinely differ
 * per agent.
 */
function attachmentDir(): string {
  const dir = join(claudeHome(), "agentglass-attachments");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write this turn's images out and return their paths. */
async function writeAttachments(images: { mediaType: string; data: string }[]): Promise<string[]> {
  const out: string[] = [];
  for (const img of images) {
    const p = join(attachmentDir(), `${crypto.randomUUID()}.${EXT[img.mediaType] ?? "png"}`);
    await Bun.write(p, Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0)));
    out.push(p);
  }
  return out;
}

/** The text actually pasted into the pane.
 *
 *  Paths are named on their own lines under a short lead-in rather than
 *  interpolated into the user's sentence, so a turn that says "compare these"
 *  still reads as theirs and the model still knows what "these" are. */
export function panePrompt(text: string, paths: string[]): string {
  if (!paths.length) return text;
  const lead = text.trim() ? `${text.trim()}\n\n` : "";
  const label = paths.length === 1 ? "Attached image" : "Attached images";
  return `${lead}${label} (read ${paths.length === 1 ? "it" : "them"} to answer):\n${paths.join("\n")}`;
}

// --- the turn ---------------------------------------------------------------

/** Transcript entry types the browser's stream parser already understands.
 *
 *  The transcript carries more than the `-p` stream did — mode changes, file
 *  history snapshots, attachment records, the CLI's own title guess. None of it
 *  means anything to the chat renderer, and forwarding it would have the browser
 *  parsing shapes no one wrote a case for. */
const FORWARD = (type: string): boolean => agent.forwards(type);

/** The line that ends a turn — an explicit marker the agent itself wrote, never
 *  a guess from a spinner or an idle screen. See paneagent.ts for why that is
 *  the load-bearing part of the contract. */
const isTurnEnd = (o: Record<string, unknown>): boolean => agent.isTurnEnd(o);

export interface PaneTurnOptions {
  cwd: string;
  message: string;
  model: string;
  mode: string;
  /** Empty means "leave the CLI's own setting alone". */
  effort: string;
  sessionId: string;
  images: { mediaType: string; data: string }[];
}

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
const NEEDS_YOU_RE = /Esc to cancel|Enter to confirm|to use this session only/;
export const __needsYou = (screen: string): boolean => NEEDS_YOU_RE.test(screen);
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

/** Wait for a queued prompt to reach the front of the CLI's queue.
 *
 *  Deliberately without a deadline. The turn ahead of ours may legitimately run
 *  for minutes — that is why ours was queued — and giving up on a clock would
 *  report a failure for a prompt that has been accepted and will run. What is
 *  bounded is liveness: a pane that has *died* is never coming back, and it is
 *  checked for on the same interval a silent turn is. */
async function waitDrained(name: string, stop: () => boolean): Promise<"drained" | "cancelled" | "gone"> {
  let lastAlive = Date.now();
  for (;;) {
    if (stop()) return "cancelled";
    if (!QUEUED_RE.test(await capture(name))) return "drained";
    if (Date.now() - lastAlive > STALL_CHECK_MS) {
      if (!(await paneAlive(name))) return "gone";
      lastAlive = Date.now();
    }
    await Bun.sleep(250);
  }
}

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
const RUNNING_RE = /esc to interrupt/i;
/** Exported for the named-agent verbs (agentops.ts): one regex, read by the
 *  chat, the clone and a script's `wait --until working` alike. */
export const __running = (screen: string): boolean => RUNNING_RE.test(screen);

/** How often to look at the screen while a turn has produced nothing at all. */
const NEEDS_YOU_PROBE_MS = 4_000;

/**
 * WHICH prompt is on screen, as a word.
 *
 * `NEEDS_YOU_RE` is three alternatives and they are three different situations:
 * a picker being cancellable, a picker asking for confirmation, and the
 * permission prompt's "for this session only". A class that is scored on
 * "would it have allowed this" has to be able to tell them apart, and it must
 * do so without keeping a line of the screen — the screen at that moment is a
 * command line, a path and sometimes a token.
 *
 * Ordered as `NEEDS_YOU_RE` is, so this and the verdict never disagree about
 * which alternative fired.
 */
function promptShape(screen: string): string {
  if (/Esc to cancel/.test(screen)) return "cancellable";
  if (/Enter to confirm/.test(screen)) return "confirm";
  if (/to use this session only/.test(screen)) return "session-only";
  return "none";
}

/**
 * Watch a prompt we sealed until he answers it, and write down what happened.
 *
 * This is the only seam in the server that observes a TRANSITION rather than a
 * frame, and that is why C6 lives here rather than at the other two
 * `NEEDS_YOU_RE` sites. Those two run inside the submit retry loop: they see one
 * frame, conclude "diverted", and hand back. A single frame can say a prompt is
 * up; only two frames can say he answered it, and the answer is the decision.
 *
 * WHAT COUNTS AS THE ANSWER. The prompt going away is the event; whether the
 * transcript grew across it is the content. A permission prompt he allowed is
 * followed by a tool running and the CLI writing, so the file grows; one he
 * declined, and a `/model` picker he escaped out of, leave it exactly where it
 * was. That is a proxy and it is named as one — but it is a proxy built from
 * two facts we already have, and the alternative is reading the words on his
 * screen, which is the thing this feature promised never to do.
 *
 * THE BOUND is `ATTACH_WINDOW_MS`, and it is the same constant on purpose:
 * past it `recordDecision` can no longer attach an actual to the seal it
 * belongs to and would open a second row marked `unsealed`, which would read as
 * a trigger that never fired when in fact it fired and we gave up watching.
 * Giving up silently leaves an unanswered seal, which is the honest shape for
 * "a prompt went up and nobody answered it inside half an hour".
 *
 * THE POLL SLOWS DOWN. Four seconds while he is plausibly at the keyboard, then
 * fifteen: a prompt is normally answered in the first few seconds, and the tail
 * of this window is the case where he walked away — where an answer arriving
 * eleven seconds late costs nothing and a `capture-pane` every four seconds for
 * twenty-nine minutes costs a spawn a person can hear the fan for.
 *
 * It never throws and it is never awaited. A scoreboard that can break a chat
 * turn is not a scoreboard anybody should be running.
 */
async function watchTheAnswer(sessionId: string, sealedAt: number, transcript: string, from: number): Promise<void> {
  const deadline = sealedAt + ATTACH_WINDOW_MS;
  const fast = sealedAt + 60_000;
  try {
    for (;;) {
      await Bun.sleep(Date.now() < fast ? NEEDS_YOU_PROBE_MS : 15_000);
      if (Date.now() > deadline) return;
      // Re-read every lap rather than once at the top. Somebody may have hit
      // halt while this prompt sat open, and "off" has to mean this loop stops
      // spawning `capture-pane` — a watcher that keeps looking for half an hour
      // after being switched off is exactly the thing nobody could promise was
      // off.
      if (!understudyEnabled()) return;
      if (!(await paneAlive(sessionId))) {
        // The pane died with the prompt still up. Somebody killed the window or
        // the CLI fell over — either way it is not him answering, so it is
        // recorded with no provenance and stays out of the denominator. It is
        // kept at all because a class whose situations mostly end this way is a
        // class watching the wrong thing.
        recordDecision("C6", {
          subject: sessionId,
          actual: { answer: "gone", tool: "no-run" },
          provenance: "",
        });
        return;
      }
      const screen = await capture(sessionId);
      if (promptShape(screen) !== "none") continue;
      const ran = (await sizeOf(transcript)) > from;
      recordDecision("C6", {
        subject: sessionId,
        actual: { answer: ran ? "allowed" : "dismissed", tool: ran ? "ran" : "no-run" },
        // He answered it in his own terminal, with keys. That is `typed`, and it
        // is the provenance the whole scorecard is built to trust.
        provenance: "typed",
      });
      return;
    }
  } catch {
    // A capture that failed, a pane that vanished between two calls. The turn it
    // belongs to finished long ago; there is nothing here worth propagating.
  }
}

/** Consecutive idle probes before a turn that never started is called over.
 *
 *  Two, so ~8s of an empty box with nothing running and not one byte written.
 *  The margin is affordable because the signal underneath is already strong: a
 *  real turn writes its own user message to the transcript within a few hundred
 *  milliseconds of being submitted (measured ~220ms), so `grew` is true almost
 *  immediately for anything that is genuinely a turn. */
const IDLE_PROBES_TO_END = 2;

/** How long a turn may go with no transcript growth at all before we check
 *  whether the pane is still alive. Long turns are silent for minutes at a time
 *  while a tool runs, so this is a liveness check, not a deadline. */
const STALL_CHECK_MS = 15_000;

/** Run one turn in the chat's pane, streaming the same ndjson the `-p` engine
 *  streams so the browser needs no new parsing. */
export function paneTurnStream(opts: PaneTurnOptions): Response {
  const { cwd, message, model, mode, effort, sessionId, images } = opts;
  const enc = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (o: Record<string, unknown>) => {
        if (cancelled) return;
        try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* client gone */ }
      };
      const fail = (error: string, extra: Record<string, unknown> = {}) => {
        emit({ type: "agx_error", code: null, error, ...extra });
      };

      try {
        const ready = await ensurePane(sessionId, cwd, model, mode, effort);
        if (!ready.ok) {
          // A pane that will not come up fails identically on every retry until
          // someone does something about it, which is exactly what the setup
          // channel is for — it surfaces as "needs you", not as a bad turn.
          fail(ready.error, { errorType: "pane_setup_required", setupCommand: "claude" });
          controller.close();
          return;
        }

        // Announce the session before anything else: the browser adopts this id
        // as the chat's own, and every later turn resumes it. Unlike the `-p`
        // engine, which discovers the id from the CLI's init frame, we chose it.
        emit({ type: "system", subtype: "init", session_id: sessionId, model, agx_engine: "tmux", agx_attach: attachCommand(sessionId) });

        const path = transcriptFor(cwd, sessionId);
        // Watermark BEFORE the prompt goes in, or the turn replays whatever the
        // session already said.
        let offset = await sizeOf(path);

        const paths = images.length ? await writeAttachments(images) : [];
        const pasted = await pasteText(sessionId, panePrompt(message, paths));
        if (!pasted.ok) { fail(pasted.stderr.trim() || "could not write the prompt into the pane"); controller.close(); return; }
        // Enter only once the text is demonstrably in the box; see waitPasted.
        const pastedBox = await waitPasted(sessionId, Date.now() + PASTE_TIMEOUT_MS);
        if (pastedBox === null) {
          fail("the prompt never landed in the chat pane's input box");
          controller.close();
          return;
        }
        const outcome = await submitConfirmed(sessionId, pastedBox, Date.now() + PASTE_TIMEOUT_MS);
        if (outcome === "stuck") {
          fail("the chat pane would not accept the prompt");
          controller.close();
          return;
        }
        if (outcome === "diverted") {
          /*
           * The CLI is showing something that wants a person, not a turn.
           *
           * `/model`, `/effort` and `/config` draw a picker and never run a
           * turn, so waiting for the transcript to grow would wait forever —
           * which is exactly how this was reported: a chat spinning on `/effort`
           * that could not be got out of.
           *
           * The picker is deliberately left open rather than cancelled with
           * Escape. The user asked for it; throwing it away to tidy up would
           * discard what they wanted. Instead, hand them the way in.
           */
          const screen = (await capture(sessionId)).split("\n").filter((l) => l.trim()).slice(-12).join("\n");
          emit({
            type: "agx_error",
            code: null,
            errorType: "pane_needs_you",
            error: `This opened an interactive prompt in the chat's tmux pane, which the chat cannot draw. `
              + `It is still open and waiting — finish it in your terminal:\n\n${attachCommand(sessionId)}\n\n${screen}`,
          });
          controller.close();
          return;
        }
        if (outcome === "queued") {
          /*
           * Accepted, but behind a turn that was already running. Wait for it
           * to come up rather than reporting anything: the prompt is in the
           * CLI's hands and it will run.
           */
          const drained = await waitDrained(sessionId, () => cancelled);
          if (drained === "cancelled") { controller.close(); return; }
          if (drained === "gone") {
            forgetPane(sessionId);
            specs.delete(sessionId);
            fail("the chat's pane exited while this prompt was still queued behind another turn");
            controller.close();
            return;
          }
          /*
           * Re-take the watermark now that ours is the turn running.
           *
           * The turn we were queued behind finished while we waited, and it
           * wrote its answer AND its end-of-turn line into this same transcript
           * after our original watermark. Streaming from there would replay
           * someone else's answer into this chat bubble and then close on their
           * end marker, ending this turn before it had said anything. Their
           * output is not lost by skipping it — the dashboard hydrates history
           * from the transcript, which is where it already is.
           *
           * The race this accepts: the CLI writes our own user message ~220ms
           * after submitting, so a slow poll can put the watermark past it. That
           * costs the echo of a message the browser is already showing, and
           * never any of the answer, which is a round trip further out.
           */
          offset = await sizeOf(path);
        }

        // Usage accumulates across the turn's assistant frames so the closing
        // cost frame can be priced. The `-p` engine gets this handed to it by
        // the CLI; here it is ours to compute.
        let inTok = 0, outTok = 0, cacheW = 0, cacheR = 0;
        const startedAt = Date.now();
        let carry = "";
        let lastGrowth = Date.now();
        // Whether this turn has produced a single byte. An interactive prompt
        // produces none, ever, which is what tells it apart from a slow one.
        let grew = false;
        let lastProbe = Date.now();
        let idleProbes = 0;

        for (;;) {
          if (cancelled) return;
          const size = await sizeOf(path);
          if (size > offset) {
            lastGrowth = Date.now();
            grew = true;
            const chunk = await Bun.file(path).slice(offset, size).text();
            offset = size;
            const lines = (carry + chunk).split("\n");
            // A trailing fragment means the CLI is mid-write; hold it until the
            // rest arrives rather than parsing half a JSON object.
            carry = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              let o: Record<string, unknown>;
              try { o = JSON.parse(line); } catch { continue; }
              if (isTurnEnd(o)) {
                const usage = {
                  input_tokens: inTok, output_tokens: outTok,
                  cache_creation_tokens: cacheW, cache_read_tokens: cacheR,
                };
                emit({ type: "result", subtype: "success", total_cost_usd: costUsd(usage, model), duration_ms: Number(o.durationMs) || 0 });
                controller.close();
                return;
              }
              if (!FORWARD(String(o.type))) continue;
              const msg = o.message as Record<string, unknown> | undefined;
              const u = msg?.usage as Record<string, unknown> | undefined;
              if (u) {
                inTok += Number(u.input_tokens) || 0;
                outTok += Number(u.output_tokens) || 0;
                cacheW += Number(u.cache_creation_input_tokens) || 0;
                cacheR += Number(u.cache_read_input_tokens) || 0;
              }
              emit(o);
            }
          } else if (!grew && Date.now() - lastProbe > NEEDS_YOU_PROBE_MS) {
            lastProbe = Date.now();
            const screen = await capture(sessionId);
            if (NEEDS_YOU_RE.test(screen)) {
              /*
               * C6's seal, and it is written before anything else in this
               * branch runs.
               *
               * The situation has to be sealed before he can answer it, and
               * from here the browser is about to be told the prompt exists —
               * so the very next thing that can happen is him going to the
               * terminal and answering. `sealSituation` is synchronous top to
               * bottom for exactly this moment.
               *
               * The body is categorical: which of the three prompts it is, and
               * whether the pane also looks busy. Not one character of `screen`
               * goes in, and `tail` below — fourteen lines of his terminal —
               * goes to the browser and nowhere near a table. That asymmetry is
               * the design: the person who asked gets the whole screen, the
               * scoreboard gets a word.
               */
              if (understudyEnabled()) {
                const sealedAt = Date.now();
                const sealed = sealSituation("C6", {
                  subject: sessionId,
                  at: sealedAt,
                  body: JSON.stringify({
                    prompt: promptShape(screen),
                    running: RUNNING_RE.test(screen),
                    queued: QUEUED_RE.test(screen),
                  }),
                });
                /* Guess before he answers — which is the whole reason the
                   seal exists a few lines up. A sealed row with no prediction
                   is honest and unscored, and a class that is never scored can
                   never earn anything. */
                if (sealed) predictSealed(sealed, "C6", sessionId);
                // Detached on purpose: the answer arrives after this stream has
                // closed, so awaiting it would hold a turn open for as long as
                // he takes to read his own screen.
                if (sealed) void watchTheAnswer(sessionId, sealedAt, path, offset);
              }
              /*
               * Left open rather than cancelled with Escape. The user asked for
               * this prompt; throwing it away to tidy up would discard what
               * they wanted. Hand them the way in instead.
               */
              const tail = screen.split("\n").filter((l) => l.trim()).slice(-14).join("\n");
              emit({
                type: "agx_error",
                code: null,
                errorType: "pane_needs_you",
                error: "This opened an interactive prompt in the chat's tmux pane, which the chat cannot draw. "
                  + `It is still open and waiting for you — finish it in your terminal:\n\n${attachCommand(sessionId)}\n\n${tail}`,
              });
              controller.close();
              return;
            }
            /*
             * Nothing written, nothing running, nothing asking. The CLI handled
             * this itself and went back to the prompt.
             *
             * `/clear` and `/compact` do exactly this — verified: no
             * `turn_duration`, no picker hints, not running — and so, presumably,
             * do commands that do not exist yet. Enumerating them is a race
             * nobody wins, which is why this is a state check rather than a list:
             * a turn that produced no transcript and left the pane idle is over,
             * whatever it was called.
             */
            // A pane holding queued prompts is neither running nor idle: it is
            // waiting its turn, and its box reads empty because what it shows
            // is a hint. Without this clause that is indistinguishable from
            // `/clear`, and a queued turn would be declared over ~8s in.
            const running = RUNNING_RE.test(screen) || QUEUED_RE.test(screen);
            const box = inputBox(screen);
            if (!running && !box?.trim()) {
              if (++idleProbes >= IDLE_PROBES_TO_END) {
                emit({
                  type: "assistant",
                  message: {
                    role: "assistant",
                    content: [{
                      type: "text",
                      text: "_This ran inside the chat's tmux pane and produced no conversation — commands like "
                        + "`/clear` and `/compact` are handled by the CLI itself. To see what it did, open the pane:_\n\n"
                        + "```\n" + attachCommand(sessionId) + "\n```",
                    }],
                  },
                });
                emit({ type: "result", subtype: "success", total_cost_usd: 0, duration_ms: Date.now() - startedAt });
                controller.close();
                return;
              }
            } else {
              idleProbes = 0;
            }
          } else if (Date.now() - lastGrowth > STALL_CHECK_MS) {
            // Silence is normal — a long tool call says nothing for minutes. What
            // is not normal is silence from a pane that has died, which would
            // otherwise hang the turn until the browser gave up.
            if (!(await paneAlive(sessionId))) {
              forgetPane(sessionId);
              specs.delete(sessionId);
              fail("the chat's pane exited before the turn finished");
              controller.close();
              return;
            }
            lastGrowth = Date.now();
          }
          await Bun.sleep(80);
        }
      } catch (e) {
        fail(String(e));
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      cancelled = true;
      // Stopping a turn must stop the work, not merely stop watching it. Escape
      // is what a person presses, and it leaves the session alive and usable for
      // the next turn — killing the pane would throw away the warm process this
      // engine exists to keep.
      void interrupt(sessionId);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** Is the pane engine usable, and if not, why in words a user can act on. */
export function paneEngineCapability(): { available: boolean; reason: string } {
  const t = tmuxCapability();
  if (!t.available) return t;
  if (!agent.bin()) return { available: false, reason: agent.missingReason() };
  return { available: true, reason: "" };
}

export { validPaneName, attachCommand };
