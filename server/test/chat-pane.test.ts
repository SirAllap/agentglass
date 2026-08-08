// The tmux chat engine's pure parts.
//
// Nothing here starts a tmux server or a `claude`. That is deliberate and not
// only about speed: a test that ran `new-session` against the default socket
// would land panes in the developer's own tmux, and this repo has already
// shipped a bug where the suite reached into a real home directory. The socket
// name and the state directory are both redirected below so that even a call
// that slipped through could not reach anything real.
import { test, expect, afterAll, beforeAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Unique per run, like the state dirs below. A fixed socket name is not a
// private server — it is a path, and anything already listening there is what
// the suite ends up talking to.
const SOCKET = `agx-pane-test-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.AGENTGLASS_STATE_DIR = join(tmpdir(), `agx-pane-test-${process.pid}`);
process.env.AGENTGLASS_CLAUDE_HOME = join(tmpdir(), `agx-claude-home-${process.pid}`);

/* A unique NAME still leaves the socket in the developer's DIRECTORY, which is
 * where a `-L` with no TMUX_TMPDIR goes: measured with a recording tmux on
 * PATH, two of this file's `list-sessions` resolved to
 * /tmp/tmux-<uid>/agx-pane-test-<pid>. Nothing was created — `list-sessions`
 * starts no server — so this is the mild end of it, and it is here for the same
 * reason the comment above gives about names: "nothing is listening there" is
 * an assumption, and `tmuxSockets()` hands every server in that directory to
 * `listPanes`. */
const TMPDIR = join(tmpdir(), `agx-tmux-chatpane-${process.pid}`);
const REAL_TMPDIR = process.env.TMUX_TMPDIR;

let mod: typeof import("../src/chatpane.ts");
let pane: typeof import("../src/tmuxpane.ts");
beforeAll(async () => {
  // In the hook, not at module scope: `bun test` shares one process across
  // files, so a module-scope write to a variable other tmux files also own
  // would outlive this one.
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  mod = await import("../src/chatpane.ts");
  pane = await import("../src/tmuxpane.ts");
});

afterAll(() => {
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* never made */ }
});

test("a working directory maps to the transcript directory Claude Code actually uses", () => {
  // Verified against a real session: every non-alphanumeric character becomes a
  // dash, so the separator and the leading dot of `.claude` each contribute one
  // and the run of two dashes is correct rather than a bug.
  expect(mod.projectSlug("/home/x/code/app")).toBe("-home-x-code-app");
  expect(mod.projectSlug("/home/x/code/app/.claude/worktrees/wt")).toBe("-home-x-code-app--claude-worktrees-wt");
  expect(mod.projectSlug("/a/b.c/d_e")).toBe("-a-b-c-d-e");
});

test("the transcript path is computable before the session has written anything", () => {
  const p = mod.transcriptFor("/home/x/repo", "6f1c9b52-0000-4000-8000-0123456789ab");
  expect(p.endsWith(join("projects", "-home-x-repo", "6f1c9b52-0000-4000-8000-0123456789ab.jsonl"))).toBe(true);
});

test("a pane name must be uuid-shaped, because tmux resolves targets from it", () => {
  expect(pane.validPaneName("6f1c9b52-0000-4000-8000-0123456789ab")).toBe(true);
  // `:` and `.` are tmux's window and pane separators. A name carrying either
  // would address a target we did not mean, and these names arrive on an HTTP
  // request, so the shape is pinned rather than escaped.
  expect(pane.validPaneName("session:1.0")).toBe(false);
  expect(pane.validPaneName("../../etc/passwd")).toBe(false);
  expect(pane.validPaneName("has space")).toBe(false);
  expect(pane.validPaneName("$(id)")).toBe(false);
  expect(pane.validPaneName("short")).toBe(false);
  expect(pane.validPaneName("")).toBe(false);
});

test("the attach command names our socket, not the user's default server", () => {
  const cmd = pane.attachCommand("6f1c9b52-0000-4000-8000-0123456789ab");
  // The `-L` is the whole reason the user's own tmux (and their resurrect saves)
  // are untouched. A command without it would attach to their server.
  expect(cmd).toContain(`-L ${SOCKET}`);
  expect(cmd).toContain("attach -t 6f1c9b52-0000-4000-8000-0123456789ab");
});

test("a turn with no attachments is pasted exactly as typed", () => {
  // Nothing may be added to a plain prompt: the text that reaches the model has
  // to be the text the user wrote.
  expect(mod.panePrompt("hello", [])).toBe("hello");
  expect(mod.panePrompt("/help is literal here\nsecond line", [])).toBe("/help is literal here\nsecond line");
});

test("attachments are named on their own lines, under the user's own words", () => {
  const out = mod.panePrompt("what is wrong here?", ["/tmp/a.png"]);
  expect(out.startsWith("what is wrong here?")).toBe(true);
  expect(out).toContain("/tmp/a.png");
  // Singular vs plural, because the sentence is read by the model and a wrong
  // plural is a wrong instruction about how many files to open.
  expect(out).toContain("Attached image (read it");
  const two = mod.panePrompt("compare", ["/tmp/a.png", "/tmp/b.png"]);
  expect(two).toContain("Attached images (read them");
  expect(two).toContain("/tmp/b.png");
});

test("an image with no text still produces a prompt that says what to do", () => {
  const out = mod.panePrompt("", ["/tmp/only.png"]);
  expect(out.startsWith("Attached image")).toBe(true);
  expect(out).toContain("/tmp/only.png");
});

test("eviction leaves a pane it has never seen before alone", async () => {
  // The sweeper must not kill a pane simply because it has no record of it —
  // after a server restart every live chat looks exactly like that, and killing
  // one mid-work to reclaim memory is far worse than holding the memory.
  pane.__resetPaneState();
  // No tmux server is running on this socket, so listPanes is empty and the
  // sweep is a no-op. What is being pinned here is that it does not throw and
  // reports nothing reclaimed.
  expect(await pane.evictIdlePanes()).toEqual([]);
});

test("a test that forgot to redirect the socket cannot start a real pane", async () => {
  // The guard that matters most in this file. Every other call here asks tmux a
  // question a missing server answers with "no"; startPane is the one that would
  // CREATE something, and without this an unrelated test importing this module
  // could put a live `claude` in the developer's own tmux.
  const saved = process.env.AGENTGLASS_TMUX_SOCKET;
  delete process.env.AGENTGLASS_TMUX_SOCKET;
  try {
    const r = await pane.startPane("6f1c9b52-0000-4000-8000-0123456789ab", "/tmp", ["/bin/true"]);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("AGENTGLASS_TMUX_SOCKET");
  } finally {
    if (saved !== undefined) process.env.AGENTGLASS_TMUX_SOCKET = saved;
  }
  // And nothing was created on the real socket.
  expect(await pane.listPanes()).toEqual([]);
});

test("tmux availability is reported with a reason a person can act on", () => {
  const cap = pane.tmuxCapability();
  expect(typeof cap.available).toBe("boolean");
  // Never available-without-explanation, and never unavailable-without-reason:
  // the settings row prints this string verbatim.
  if (!cap.available) expect(cap.reason.length).toBeGreaterThan(0);
});

// --- interactive commands ---------------------------------------------------
// `/model`, `/effort` and `/config` do not run a turn; they draw a picker. Two
// things went wrong with that, and the second was the dangerous one.

/** A real `/model` picker, captured from a live pane. Note the selection cursor:
 *  the picker draws it with the SAME `❯` glyph the input box uses. */
const MODEL_PICKER = [
  "   Select model",
  "   Switch between Claude models. Your pick becomes the default for new sessions.",
  "     1. Default (recommended)  Opus 5 with 1M context",
  "     4. Sonnet                 Sonnet 5 · Efficient for routine tasks",
  "   ❯ 5. Haiku ✔                Haiku 4.5 · Fastest for quick answers",
  "   Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");

/** The ordinary case: history above, the live box last. */
const NORMAL = [
  "❯ Say hello",
  "  ⎿  did the thing",
  "● hello",
  "────────────",
  "❯ ",
].join("\n");

test("the live input box is the last prompt row, not the first", () => {
  // A submitted prompt stays on screen with the same glyph, so reading the
  // first match reported failure on a turn that had already answered.
  expect(mod.inputBox(NORMAL)?.trim()).toBe("");
});

test("a picker's indented cursor is not read as the input box", () => {
  // The picker draws its cursor with the same `❯` glyph, but indented, so the
  // box detector ignores it. That is why the submit retry did not walk the menu
  // — worth pinning, because a picker that ever drew its cursor at column 0
  // would turn every retried Enter into a menu selection.
  expect(mod.inputBox(MODEL_PICKER)).toBeNull();
});

test("an interactive prompt is recognised from its key hints", () => {
  // This is what stops the turn hanging: `/model`, `/effort` and `/config`
  // never write to the transcript, so without this the chat waits forever.
  expect(mod.__needsYou(MODEL_PICKER)).toBe(true);
});

test("a running turn is not mistaken for an interactive prompt", () => {
  // A turn in flight says "esc to interrupt"; a picker says "Esc to cancel".
  // Confusing the two would abandon every long turn four seconds in.
  expect(mod.__needsYou("● working…\n✻ Brewed for 12s (esc to interrupt)")).toBe(false);
});

test("a screen with no prompt row at all reads as taken", () => {
  // While a turn runs the TUI redraws and the prompt row can be off-screen
  // entirely; that must count as accepted rather than as a lost prompt.
  expect(mod.inputBox("● working…\n✻ Brewed for 2s")).toBeNull();
});

/** `/clear` leaves no trace at all: nothing written, no picker, not running.
 *  Captured from a live pane — this is the case that enumerating commands
 *  would always have missed. */
const IDLE_AFTER_LOCAL_COMMAND = [
  "▐▛███▜▌   Claude Code v2.1.220",
  "────────────",
  "❯ ",
  "────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

test("a pane that went quiet with nothing written is idle, not working", () => {
  // The general rule the picker check cannot cover: `/clear` and `/compact`
  // produce no turn, no hints and no activity. A turn waiting on the CLI's own
  // end-of-turn line would wait for one that is never written.
  expect(mod.__needsYou(IDLE_AFTER_LOCAL_COMMAND)).toBe(false);
  expect(mod.__isRunning(IDLE_AFTER_LOCAL_COMMAND)).toBe(false);
  expect(mod.inputBox(IDLE_AFTER_LOCAL_COMMAND)?.trim()).toBe("");
});

test("a working turn is never idle, however long it says nothing", () => {
  // The one that must not regress: a tool call can be silent for minutes, and
  // ending the turn under it would throw away work in flight.
  const working = "● Reading files…\n✻ Brewed for 94s (esc to interrupt)";
  expect(mod.__isRunning(working)).toBe(true);
  expect(mod.__needsYou(working)).toBe(false);
});

// --- answering a prompt in the pane -----------------------------------------

test("only navigation keys may be sent into a live pane", () => {
  // These arrive on an HTTP request and land in a terminal running an agent
  // with tools. An unbounded key channel would be a way to type commands into
  // it, so this is an allowlist rather than a sanitiser. Ordinary text still
  // goes through the paste path, which cannot be mistaken for a keystroke.
  for (const k of ["Up", "Down", "Left", "Right", "Enter", "Escape"]) {
    expect(pane.sendableKey(k)).toBe(true);
  }
  for (const k of ["C-c", "rm -rf /", "q", "", "Enter Enter", "M-x", 5, null, "escape"]) {
    expect(pane.sendableKey(k as unknown)).toBe(false);
  }
});

test("a key for an invalid pane name is refused before tmux is reached", async () => {
  // Same reasoning as every other pane entry point: the name decides the tmux
  // target, so a crafted one must never get as far as being resolved.
  const r = await pane.sendKey("other:1.0", "Enter");
  expect(r.ok).toBe(false);
  expect(r.stderr).toContain("invalid pane name");
});

test("a disallowed key is refused even for a valid pane", async () => {
  const r = await pane.sendKey("6f1c9b52-0000-4000-8000-0123456789ab", "C-c");
  expect(r.ok).toBe(false);
  expect(r.stderr).toContain("not allowed");
});

// --- never press Enter twice into a menu ------------------------------------
// Enter in a `/model` or `/effort` picker means "set as default": it writes the
// user's real settings.json. This happened on a live machine, twice, once from
// a chat that merely looked like it was thinking.

/** The frame that caused it: the menu has drawn, but the input box row above it
 *  still shows the command from before the redraw. */
const PICKER_WITH_STALE_BOX = [
  "❯ /effort",
  "   Effort",
  "   low   medium   high   xhigh   max",
  "   ←/→ to adjust · Enter to confirm · Esc to cancel",
].join("\n");

test("a menu on screen stops the retry even when the box looks unsent", () => {
  // The ordering IS the fix. Reading the box first sees "/effort" still there,
  // concludes the Enter was swallowed, and presses again — confirming the menu.
  expect(mod.__submitVerdict(PICKER_WITH_STALE_BOX, "/effort")).toBe("diverted");
});

test("a genuinely swallowed Enter is still retried", () => {
  // The behaviour this must not break: the TUI folds the first Enter into the
  // bracketed paste, so without a retry ordinary turns are silently lost.
  const stillWaiting = ["❯ write me a test", "────────", "  ⏵⏵ bypass permissions on"].join("\n");
  expect(mod.__submitVerdict(stillWaiting, "write me a test")).toBe("retry");
});

test("an emptied box is taken as sent", () => {
  expect(mod.__submitVerdict("● thinking…\n❯ \n────────", "write me a test")).toBe("sent");
});

// The pane's command must not be run by the user's login shell.
//
// tmux executes a bare command string with the login shell, and the string
// below is POSIX — `$?`, `exec`, `;`. On a machine whose shell is fish that is
// a syntax error ("In fish, please use $status"), so the command died on the
// spot, the session died with it, and the tmux server exited leaving an
// orphaned socket. The chat reported "the pane never became ready in 45s" over
// an empty screen, because by the time anything looked there was nothing to
// look at — a message that points nowhere near a shell.
//
// Asserted on the argv rather than by starting a pane: reproducing it for real
// needs a machine whose login shell is not POSIX, which CI is not.
test("the pane command is handed to sh, not to whatever the user's shell is", () => {
  const argv = pane.newSessionArgv("6f1c9b52-0000-4000-8000-0123456789ab", "/tmp", ["claude", "--model", "opus"]);
  const i = argv.indexOf("sh");
  expect(i).toBeGreaterThan(-1);
  expect(argv[i + 1]).toBe("-c");
  // The command is the argument to `sh -c`, and the last word, so nothing can
  // be appended after it and end up interpreted by something else.
  expect(argv[i + 2]).toBe(argv[argv.length - 1]);
  expect(argv[argv.length - 1]).toContain("$?");
});

test("the session is still named, placed and sized as before", () => {
  const argv = pane.newSessionArgv("6f1c9b52-0000-4000-8000-0123456789ab", "/some/dir", ["claude"]);
  expect(argv.slice(0, 2)).toEqual(["new-session", "-d"]);
  expect(argv[argv.indexOf("-s") + 1]).toBe("6f1c9b52-0000-4000-8000-0123456789ab");
  expect(argv[argv.indexOf("-c") + 1]).toBe("/some/dir");
  expect(argv[argv.indexOf("-x") + 1]).toBe("200");
});

test("an argument with a quote in it cannot break out of the command", () => {
  const argv = pane.newSessionArgv("6f1c9b52-0000-4000-8000-0123456789ab", "/tmp", ["claude", "--say", "it's; rm -rf /"]);
  const cmd = argv[argv.length - 1]!;
  // Single-quoted with the POSIX '\'' escape, so the `;` stays inside the word.
  expect(cmd).toContain(`'it'\\''s; rm -rf /'`);
});

// --- a prompt sent while the CLI is busy -------------------------------------
// Typing into Claude Code mid-turn does not fail and does not interrupt: the
// prompt is queued and runs when the current turn ends. The engine had no name
// for that state and read it as two different wrong ones, so two prompts that
// were accepted — and that ran — were both reported to the user as errors.

/** Captured from a live pane whose network had dropped mid-turn. The CLI is
 *  still working on the first prompt, two prompts sent from the chat since are
 *  queued behind it, and the input box shows the hint it draws while it holds
 *  them. Note that the queued prompts carry the box's own `❯` glyph at column
 *  zero, exactly as the live box does. */
const QUEUED = [
  "❯ why does the release build fail on a clean checkout?",
  "",
  "✳ Unable to connect to API (ENOTIMP) · Retrying in 8s · attempt 5/10",
  "",
  "❯ continue",
  "❯ continue",
  "                              ✗ Auto-update failed · Run claude doctor",
  "",
  "❯ Press up to edit queued messages",
].join("\n");

test("the input box's hint is not something the user typed", () => {
  // The whole bug in one assertion. Read as content, the hint is text that is
  // neither empty nor the prompt we pasted — which is the exact signature of a
  // picker having opened, and is what got reported as one.
  expect(mod.inputBox(QUEUED)?.trim()).toBe("");
  expect(mod.inputBox('❯ Try "edit config.ts to add a flag"')?.trim()).toBe("");
});

test("but a prompt that merely starts like a hint is still a prompt", () => {
  // The cost of getting this wrong is silent and total: a box holding real text
  // that reads as empty is one waitPasted never sees the paste land in, so the
  // turn spends its deadline pressing Enter and then reports a pane that would
  // not accept the prompt. A hint owns its whole row; a prompt carries on past
  // it, which is what both anchors are for.
  for (const typed of [
    'Try "npm test" first, then look at the failures',
    'Try "bun run build" and tell me what breaks',
    "Try the other approach",
  ]) {
    expect(mod.inputBox(`❯ ${typed}`)?.trim(), typed).toBe(typed);
  }
  // And the same on the other hint, so neither can be loosened alone.
  expect(mod.inputBox("❯ Press up to edit queued messages, then rerun")?.trim())
    .toBe("Press up to edit queued messages, then rerun");
});

test("a queued prompt is accepted, not diverted into a picker", () => {
  // Reported as: "This opened an interactive prompt in the chat's tmux pane."
  // Nothing had opened. The prompt was queued, and it ran.
  expect(mod.__submitVerdict(QUEUED, "continue")).toBe("queued");
  expect(mod.__isQueued(QUEUED)).toBe(true);
});

test("a second prompt is not compared against the hint left by the first", () => {
  // Reported as: "the chat pane would not accept the prompt." With the hint
  // already on screen before the paste, the old box reader handed it back as
  // though it were our text, and every Enter afterwards compared it against
  // itself and looked swallowed — so the turn pressed Enter into a live pane
  // until it timed out. An empty-reading box keeps the paste wait waiting.
  expect(mod.__submitVerdict(QUEUED, "Press up to edit queued messages")).toBe("queued");
  expect(mod.inputBox(QUEUED)?.trim()).not.toBe("Press up to edit queued messages");
});

test("a queued pane is not mistaken for a menu, or for one gone idle", () => {
  // The two states either side of it. Reading queued as `needsYou` would send
  // the user to their terminal to finish a prompt that does not exist; reading
  // it as idle would end the turn ~8s in, because the box reads empty and
  // nothing says "esc to interrupt" while the CLI waits.
  expect(mod.__needsYou(QUEUED)).toBe(false);
  expect(mod.__isRunning(QUEUED)).toBe(false);
  expect(mod.__isQueued(NORMAL)).toBe(false);
  expect(mod.__isQueued(IDLE_AFTER_LOCAL_COMMAND)).toBe(false);
  expect(mod.__isQueued(MODEL_PICKER)).toBe(false);
});

test("a picker still wins over a queue, so Enter is never pressed into a menu", () => {
  // Ordering, again: the queue check sits below the picker check. Enter in a
  // `/model` or `/effort` menu writes the user's real settings.json, and no
  // other state may be allowed to reach past that guard.
  expect(mod.__submitVerdict(`${MODEL_PICKER}\n❯ Press up to edit queued messages`, "/model")).toBe("diverted");
});
