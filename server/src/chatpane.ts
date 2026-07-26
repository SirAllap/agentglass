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
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { costUsd } from "./pricing.ts";
import {
  paneAlive, startPane, killPane, pasteText, submit, interrupt, capture,
  touchPane, forgetPane, tmuxCapability, validPaneName, attachCommand,
} from "./tmuxpane.ts";

const claudeBin = () => Bun.which("claude");

/** Where Claude Code keeps its transcripts. `CLAUDE_CONFIG_DIR` is the CLI's own
 *  knob and is honoured for the same reason it exists; the agentglass override
 *  is so tests can point at a fixture instead of a developer's real history. */
function claudeHome(): string {
  return process.env.AGENTGLASS_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** The directory name Claude Code derives from a working directory.
 *
 *  Every character that is not a letter or a digit becomes `-`, which is why a
 *  path like `/home/x/code/app/.claude/wt` lands in `-home-x-code-app--claude-wt`
 *  (the separator and the leading dot each contribute one). Verified against a
 *  real session rather than inferred. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Where this session's transcript will be, whether or not it exists yet. The
 *  path has to be computable up front: a brand-new session has no file until it
 *  has answered something, and the turn needs to know where to watch. */
export function transcriptFor(cwd: string, sessionId: string): string {
  return join(claudeHome(), "projects", projectSlug(cwd), `${sessionId}.jsonl`);
}

/** Size of a file, or 0 when it does not exist.
 *
 *  This is the turn's watermark. Reading only what is appended after it is what
 *  keeps a turn from replaying the whole conversation into the browser. */
async function sizeOf(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

// What we launched each pane with. A chat that changes model or permission mode
// mid-conversation cannot be honoured by an already-running CLI — both are
// process-level here — so the pane is relaunched with `--resume`, which costs
// one slow turn and keeps the conversation intact.
interface PaneSpec { model: string; mode: string; cwd: string }
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

/** What is typed in the live input box right now, or `null` if it is not on
 *  screen at all (the TUI redraws while a turn runs). Note the box renders its
 *  empty state with U+00A0, which `\s` covers. */
export function inputBox(screen: string): string | null {
  let last: string | null = null;
  for (const m of screen.matchAll(INPUT_ROWS)) last = m[1];
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
 *  `sent` — the box emptied, the CLI took it.
 *  `diverted` — the box holds something that is not our prompt any more. In
 *    practice this means an interactive command opened a picker: `/model`,
 *    `/effort`, `/config` do not run a turn, they draw a menu.
 *  `stuck` — still our text, still not taken, out of time. */
type SubmitOutcome = "sent" | "diverted" | "stuck";

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
    // Long enough for the TUI to redraw after accepting, short enough that the
    // common case (accepted on the second press) is not perceptibly slower.
    await Bun.sleep(250);
    const box = inputBox(await capture(name));
    if (!box?.trim()) return "sent";
    /*
     * Only keep pressing while the box still holds OUR prompt.
     *
     * This guard is the whole reason the retry is safe. Claude Code's pickers
     * draw their selection cursor with the same `❯` glyph as the input box, so
     * a `/model` menu reads as "box still full" — and in that menu Enter means
     * "set as default". Retrying blindly walked straight into changing the
     * user's saved model and effort, silently, from a chat that appeared to be
     * hanging. Verified by reproducing it: a second Enter after `/effort`
     * printed "Set effort level to xhigh (saved as your default for new
     * sessions)".
     */
    if (box.trim() !== pasted.trim()) return "diverted";
    if (Date.now() > deadline) return "stuck";
  }
}

/** Ensure a live pane for this session, launching or relaunching as needed.
 *
 *  The distinction that matters: a session id that has never run must be started
 *  with `--session-id`, and one that has must be started with `--resume`. Reusing
 *  `--session-id` on an existing session is a hard error ("Session ID is already
 *  in use"), so getting this backwards does not degrade, it fails the turn. */
async function ensurePane(
  sessionId: string, cwd: string, model: string, mode: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const bin = claudeBin();
  if (!bin) return { ok: false, error: "no local `claude` CLI — install Claude Code to chat" };

  const alive = await paneAlive(sessionId);
  const spec = specs.get(sessionId);
  // A live pane whose model or mode no longer matches what the chat is asking
  // for cannot be re-flagged in place; take it down and bring it back resumed.
  if (alive && spec && (spec.model !== model || spec.mode !== mode)) {
    await killPane(sessionId);
    specs.delete(sessionId);
  } else if (alive) {
    touchPane(sessionId);
    return { ok: true };
  }

  const fresh = (await sizeOf(transcriptFor(cwd, sessionId))) === 0;
  const argv = [bin, "--model", model];
  if (fresh) argv.push("--session-id", sessionId);
  else argv.push("--resume", sessionId);
  if (mode === "bypassPermissions") argv.push("--dangerously-skip-permissions");
  else argv.push("--permission-mode", mode);

  const started = await startPane(sessionId, cwd, argv);
  if (!started.ok) return { ok: false, error: started.stderr.trim() || "could not start the tmux pane" };

  if (!(await waitReady(sessionId, Date.now() + READY_TIMEOUT_MS))) {
    // Hand back what the pane is actually showing. When this fires it is almost
    // always a login prompt or an unaccepted agreement, and the screen says so
    // far better than any sentence written here in advance could.
    const screen = (await capture(sessionId)).trim().split("\n").filter(Boolean).slice(-6).join("\n");
    return { ok: false, error: `the chat pane never became ready in ${Math.round(READY_TIMEOUT_MS / 1000)}s.\n${screen}` };
  }
  specs.set(sessionId, { model, mode, cwd });
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
const FORWARD = new Set(["assistant", "user"]);

/** The line that ends a turn.
 *
 *  Deterministic and written by the CLI itself: every completed turn's last
 *  transcript line is a `system` entry with subtype `turn_duration`. This is why
 *  the engine never has to guess from a spinner or an idle screen. */
const isTurnEnd = (o: Record<string, unknown>): boolean =>
  o.type === "system" && o.subtype === "turn_duration";

export interface PaneTurnOptions {
  cwd: string;
  message: string;
  model: string;
  mode: string;
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

/** How often to look at the screen while a turn has produced nothing at all. */
const NEEDS_YOU_PROBE_MS = 4_000;

/** How long a turn may go with no transcript growth at all before we check
 *  whether the pane is still alive. Long turns are silent for minutes at a time
 *  while a tool runs, so this is a liveness check, not a deadline. */
const STALL_CHECK_MS = 15_000;

/** Run one turn in the chat's pane, streaming the same ndjson the `-p` engine
 *  streams so the browser needs no new parsing. */
export function paneTurnStream(opts: PaneTurnOptions): Response {
  const { cwd, message, model, mode, sessionId, images } = opts;
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
        const ready = await ensurePane(sessionId, cwd, model, mode);
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

        // Usage accumulates across the turn's assistant frames so the closing
        // cost frame can be priced. The `-p` engine gets this handed to it by
        // the CLI; here it is ours to compute.
        let inTok = 0, outTok = 0, cacheW = 0, cacheR = 0;
        let carry = "";
        let lastGrowth = Date.now();
        // Whether this turn has produced a single byte. An interactive prompt
        // produces none, ever, which is what tells it apart from a slow one.
        let grew = false;
        let lastProbe = Date.now();

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
              if (!FORWARD.has(String(o.type))) continue;
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
  if (!claudeBin()) return { available: false, reason: "no local `claude` CLI — install Claude Code to chat" };
  return { available: true, reason: "" };
}

export { validPaneName, attachCommand };
