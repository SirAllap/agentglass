// The interactive pane a run actually gets, with `-p` kept below it.
//
// `runAgentInPane` (index.ts) already opens a tmux window for a run and reads
// its output, but it launches `claude -p` — one shot, gone the moment it
// exits. `/model` and `/effort` are process-level flags on that CLI, so a run
// cannot change either of them once started, which is exactly the thing he
// does mid-task: drop to sonnet for the mechanical stretch, back up to opus
// for the thinking. `-p` cannot be told that after launch.
//
// This opens the same kind of window — same lease, same size, same session —
// and starts the real interactive CLI in it instead, the one chatpane.ts
// already knows how to drive. Turn-end comes from `paneagent.isTurnEnd`, an
// explicit marker Claude Code writes to its transcript, never from an idle
// screen: a tool that takes four minutes looks exactly like a pane with
// nothing left to say.
//
// Falls back to `null` only when no window could be opened at all — no tmux,
// no `claude` binary, or the window itself refused. Once a window exists and
// is leased, this function owns closing it and always returns a verdict, the
// same contract `runAgentInPane` keeps. The caller falls through to that `-p`
// pane, and from there to the hidden spawn, exactly as it already does when
// tmux refuses — this is one more rung above them, not a replacement.
//
// Read chatpane.ts before touching this file. The paste/submit dance below is
// the one in there, minus the parts that only make sense for a chat somebody
// is typing into live (queueing, picker hand-off) — a run's first message
// always lands in an idle, freshly-started session.
import { stat } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { engineWindowRunning, tmux, tmuxCapability } from "./tmuxpane.ts";
import { takeLease, endLease } from "./panelease.ts";
import { claudeCode } from "./agents/claudecode.ts";
import { inputBox, __submitVerdict, __needsYou } from "./chatpane.ts";
import { pushUnderstudyStuck } from "./alerts.ts";

const agent = claudeCode;

const READY_TIMEOUT_MS = Number(process.env.AGENTGLASS_PANE_READY_TIMEOUT_MS ?? 45_000);
const PASTE_TIMEOUT_MS = Number(process.env.AGENTGLASS_PANE_PASTE_TIMEOUT_MS ?? 10_000);

/** How long a prompt must stay ON SCREEN before it is treated as something
 *  only a person can answer. A guard against a false positive, not a deadline —
 *  `__needsYou` matches a picker's own key hints, and hints that merely scroll
 *  past in a tool's output are gone by the second look, while a real prompt is
 *  still sitting there.
 *
 *  Measured against the screen rather than against transcript growth, which is
 *  what this used to be and is a different question — see the loop below for
 *  the numbers. Window aliveness is checked every tick and gated on neither: a
 *  dead process takes its window with it immediately.
 *
 *  Kept under ten seconds — a run stuck on a prompt nobody will ever answer
 *  should die fast, not sit there for a quarter of a minute burning its own
 *  clock. Configurable for the same reason as the two above it: a test that has
 *  to spend the real one to see the behaviour is a test nobody runs. */
const STALL_CHECK_MS = Number(process.env.AGENTGLASS_PANE_STALL_CHECK_MS ?? 8_000);

/*
 * THE QUIET AGENT — alive, not asking, not saying, not doing.
 *
 * Measured: a dead process is noticed in five seconds; a live one that has
 * gone silent ran to the task's whole budget, forty-five minutes, with nobody
 * looking. Nothing watched for it: the loop read the transcript for a turn
 * end and the screen for a prompt, and a pane with neither looked exactly like
 * a pane in the middle of a long tool call.
 *
 * So the screen is read for CHANGE, with the volatile parts masked — the
 * spinner's seconds, token counts, hashes, times, paths — so a frame that
 * only ticked reads as the same frame, and a transcript that grew counts as
 * progress too. Quiet = neither changed. The threshold is generous and the
 * first action is a WORD, not a kill: this repo once stopped an agent at
 * twenty-five minutes that was working (the comment is in this file), so it
 * warns at ten and stops at twenty — still under half the budget it used to
 * burn. Both configurable, for the suite that has to see it in seconds.
 */
const QUIET_WARN_MS = Number(process.env.AGENTGLASS_PANE_QUIET_MS ?? 10 * 60_000);
const QUIET_STOP_MS = Number(process.env.AGENTGLASS_PANE_QUIET_STOP_MS ?? 20 * 60_000);

/** A screen reduced to what does not tick: digits, hex, times and paths are
 *  masked, whitespace collapsed, and only the newest lines kept. Two captures
 *  of one situation give one signature; new output gives another. */
export function screenSignature(screen: string, lines = 40): string {
  return screen
    .split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-lines).join("\n")
    .replace(/\b[0-9a-f]{6,}\b/gi, "#")
    .replace(/\d+[:.]\d+(?:[:.]\d+)?/g, "0")
    .replace(/\d+/g, "0")
    .replace(/(?:~|\/)[\w.@-]+(?:\/[\w.@-]+)+/g, "/p")
    .replace(/[ \t]+/g, " ");
}

/** `capture-pane` / `paste-buffer` / `send-keys` all take a raw tmux target,
 *  and a window id (`@7`) is one: it resolves to that window's own pane, the
 *  only one it has. `tmuxpane.ts`'s versions of these are gated on
 *  `validPaneName`, which is the shape of a UUID-named chat SESSION, not a
 *  window id inside the shared engine session this run lives in — so they are
 *  reimplemented here, thin, rather than widened to accept a second shape. */
async function captureRaw(windowId: string): Promise<string> {
  const r = await tmux(["capture-pane", "-p", "-t", windowId]);
  return r.ok ? r.stdout : "";
}
async function pasteRaw(windowId: string, text: string): Promise<boolean> {
  const buf = `agx-run-${windowId.replace("@", "")}`;
  const load = await tmux(["load-buffer", "-b", buf, "-"], text);
  if (!load.ok) return false;
  return (await tmux(["paste-buffer", "-b", buf, "-t", windowId, "-d", "-p"])).ok;
}
async function submitRaw(windowId: string): Promise<void> {
  await tmux(["send-keys", "-t", windowId, "Enter"]);
}

/** `capture-pane` on a window that has already closed fails outright rather
 *  than returning empty text, so `null` here means "gone", not "blank". */
async function captureOrGone(windowId: string): Promise<string | null> {
  const r = await tmux(["capture-pane", "-p", "-t", windowId]);
  return r.ok ? r.stdout : null;
}

/** Same forty lines `paneTail` in index.ts leaves behind a `-p` run, for the
 *  same reason: a death with no window left to show is still worth naming
 *  rather than leaving the caller with nothing at all. `screen` is the most
 *  recent capture this run managed to take — by the time a death is noticed
 *  the window itself is usually already gone, so there is nothing fresher to
 *  ask for. */
function paneTail(screen: string): string {
  const text = screen.trimEnd();
  if (!text) return "\n--- its window was already gone before anything could be captured off it ---";
  return `\n--- what its window had on screen ---\n${text.split("\n").slice(-40).join("\n")}`;
}

async function sizeOf(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

async function waitReady(windowId: string, deadline: number): Promise<boolean> {
  for (;;) {
    if (inputBox(await captureRaw(windowId)) !== null) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(150);
  }
}

async function waitPasted(windowId: string, deadline: number): Promise<string | null> {
  for (;;) {
    const box = inputBox(await captureRaw(windowId));
    if (box?.trim()) return box;
    if (Date.now() > deadline) return null;
    await Bun.sleep(60);
  }
}

/** Press Enter until the brief is actually taken. See chatpane.ts's own
 *  `submitConfirmed` for why the first Enter after a paste is routinely lost,
 *  not merely late — `__submitVerdict` is the exact decision that function
 *  makes, exported from there so the two never disagree about it. */
async function submitConfirmed(windowId: string, pasted: string, deadline: number) {
  for (;;) {
    await submitRaw(windowId);
    await Bun.sleep(600);
    const verdict = __submitVerdict(await captureRaw(windowId), pasted);
    if (verdict !== "retry") return verdict;
    if (Date.now() > deadline) return "stuck" as const;
  }
}

/**
 * A CLAUDE_CONFIG_DIR of the clone's own, so his hooks are not its hooks.
 *
 * Read off a real run: the first thing in this agent's context, ahead of the
 * brief, was his own UserPromptSubmit hook — "CRITICAL FIRST ACTION — Execute
 * this ToolSearch NOW", naming thirteen memory tools. He has fourteen kinds of
 * hook configured. Every one of them fired on a run that is not a
 * conversation with him, and the agent spent its opening turn chasing tools
 * that are not in its environment.
 *
 * `--settings '{"hooks":{}}'` does not do this: measured, the hook still
 * arrived, because --settings loads ADDITIONAL settings rather than replacing
 * them. `--bare` does skip hooks and also refuses OAuth, which is how he is
 * signed in, so it would trade a nuisance for a run that cannot start.
 * CLAUDE_CONFIG_DIR is the one that worked — measured the same way, by asking
 * the model whether the text had arrived: with it, "nothing mentioned the
 * source it was told about".
 *
 * The credentials are SYMLINKED rather than copied, so a token he rotates is
 * rotated here too and there is never a second copy of it on disk. If the file
 * is not there at all — an API key in the environment, a keychain — this makes
 * an empty directory and the CLI finds its credential the way it already did.
 *
 * Returns null if the directory cannot be made, and the caller then runs
 * exactly as before: an inherited hook is a nuisance, and no run at all is
 * worse than a nuisance.
 */
/**
 * And this directory is one it has been told to trust.
 *
 * Read off three dead runs, once the pane's screen was finally being reported:
 *
 *     the chat pane never became ready in 45s
 *     Accessing workspace: …-scope-automations-…
 *     Quick safety check: Is this a project you created or one you trust?
 *
 * The CLI asks that once per directory it has not seen. The clone cuts a FRESH
 * WORKTREE for every task — that is the whole design, isolation instead of
 * reversibility — so every single run lands in a directory nobody has ever
 * answered for, and sits there until the clock runs out.
 *
 * It never showed up before the isolated config went in, because his own
 * `.claude.json` has an entry for everything he has ever opened, and the
 * worktrees are under a path he had already answered for. A private config
 * directory starts with none.
 *
 * So the answer is written before the pane opens: this is his machine, his
 * repository, and a worktree the app itself just cut off his own branch. There
 * is nobody else to ask.
 */
function trustDir(home: string, dir: string): void {
  try {
    const file = join(home, ".claude.json");
    const state = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8")) as { projects?: Record<string, Record<string, unknown>> }
      : {};
    state.projects ??= {};
    if (state.projects[dir]?.hasTrustDialogAccepted) return;
    state.projects[dir] = { ...(state.projects[dir] ?? {}), hasTrustDialogAccepted: true };
    writeFileSync(file, JSON.stringify(state, null, 2));
  } catch { /* unwritable: the pane will ask, and the screen will say so */ }
}

function cloneClaudeHome(): string | null {
  try {
    const base = process.env.AGENTGLASS_STATE_DIR
      || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
    const dir = join(base, "clone-claude");
    mkdirSync(join(dir, "projects"), { recursive: true });
    const cred = join(homedir(), ".claude", ".credentials.json");
    const here = join(dir, ".credentials.json");
    if (existsSync(cred) && !existsSync(here)) symlinkSync(cred, here);

    /*
     * AND IT HAS ALREADY BEEN THROUGH THE FRONT DOOR.
     *
     * A config directory the CLI has never seen is a FIRST RUN, and a first
     * run means onboarding: "Let's get started. Choose the text style that
     * looks best." Measured, by reproducing the start by hand — that is
     * exactly what three dead runs had on screen behind "the chat pane never
     * became ready".
     *
     * It did not show up in the check that chose this directory in the first
     * place, because that check used `-p`, and one-shot mode skips the
     * ceremony. The pane does not.
     *
     * Written, not copied: this file is a hundred kilobytes of his projects,
     * his history and his tips. The clone needs four fields — that onboarding
     * is done, which version did it, when it started, and a theme — and has no
     * business holding the rest. Only when there is nothing here, so anything
     * the clone learns about itself later survives.
     */
    const state = join(dir, ".claude.json");
    if (!existsSync(state)) {
      let theme = "dark";
      let version = "";
      try {
        const his = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as
          { theme?: string; lastOnboardingVersion?: string };
        if (his.theme) theme = his.theme;
        if (his.lastOnboardingVersion) version = his.lastOnboardingVersion;
      } catch { /* his file is not required — the defaults below stand alone */ }
      writeFileSync(state, JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: version || "2.0.0",
        firstStartTime: new Date().toISOString(),
        theme,
      }, null, 2));
    }
    /*
     * AND THE BYPASS AGREEMENT, which is the one that actually stopped it.
     *
     * `--dangerously-skip-permissions` shows a one-time screen — "1. No, exit
     * / 2. Yes, I accept" — and it is accepted once per CONFIG DIRECTORY, in
     * settings.json rather than in .claude.json. His has it. A private config
     * directory does not, so every run sat on that prompt until the clock ran
     * out, which is what "the chat pane never became ready" was for three days
     * of runs.
     *
     * Found by A/B rather than by reading: the same command in the same
     * worktree, once with his config and once with this one. His came up at a
     * prompt; this one came up at the agreement. That is the whole diagnosis,
     * and it took twenty seconds after two wrong guesses that each looked
     * right on their own.
     *
     * Written only when there is no settings.json, so anything the clone is
     * given later stays. The flag is not a new permission — the mode is
     * already chosen by the caller, on his machine, in a worktree this app
     * cut off his own branch; this is only the acknowledgement that nobody is
     * sitting there to press 2.
     */
    const settings = join(dir, "settings.json");
    if (!existsSync(settings)) {
      writeFileSync(settings, JSON.stringify({ skipDangerousModePermissionPrompt: true }, null, 2));
    }
    return dir;
  } catch {
    return null;
  }
}

export async function runAgentInteractivePane(p: {
  cwd: string; root: string; label: string; model: string; effort: string;
  prompt: string; env: Record<string, string>; timeoutMs: number;
  onPane?: (paneId: string) => void;
  /** The quiet warning, for a caller that keeps its own record (the run
   *  loop's ledger); the alert goes out either way. */
  onQuiet?: (quietForMs: number) => void;
}): Promise<{ ok: boolean; out: string } | null> {
  const can = tmuxCapability();
  if (!can.available) return null;
  if (!agent.bin()) return null;

  const sessionId = randomUUID();
  const argv = agent.argv({
    sessionId, cwd: p.cwd, model: p.model, effort: p.effort, mode: "bypassPermissions", fresh: true,
    unattended: true,
  });

  const home = cloneClaudeHome();
  /* Every run is a directory the CLI has never seen — see trustDir. */
  if (home) trustDir(home, p.cwd);

  // Prevent spawned subprocesses from inheriting TMUX. If a subprocess starts
  // agentglass and inherits this variable, it could reconnect to the same
  // socket and interfere with our tmux commands, causing exit detection to fail.
  const paneEnv = { ...p.env, TMUX: "", ...(home ? { CLAUDE_CONFIG_DIR: home } : {}) };

  const win = await engineWindowRunning(p.root, `understudy: ${p.label}`.slice(0, 60), argv, p.cwd, paneEnv);
  if (!win) return null;

  // Same reasoning as runAgentInPane: a window with no client attached opens
  // at 80x24, which cuts every interesting line in half.
  await tmux(["set-window-option", "-t", win.windowId, "window-size", "manual"]);
  await tmux(["resize-window", "-t", win.windowId, "-x", "200", "-y", "50"]);

  // Leased before anything is typed into it — from here on this window is
  // ours to close, and only ours. See panelease.ts.
  await takeLease(win.windowId, `understudy: ${p.label}`);
  p.onPane?.(win.paneId);

  try {
    const deadline = Date.now() + p.timeoutMs;

    /*
     * THE SCREEN, on every way a start can fail.
     *
     * The two failures further down hand back `paneTail(...)` and these three
     * handed back a sentence. Which is how three runs died saying "the chat
     * pane never became ready" with nothing to say WHY — and when this fires
     * it is almost always something the pane is plainly showing: a login
     * prompt, an agreement waiting to be accepted, a CLI refusing an argument.
     * The equivalent in chatpane.ts has always attached the screen; this had
     * the same helper sitting ten lines up and did not call it.
     *
     * `captureOrGone` rather than a plain capture: a window that is already
     * gone is itself the answer, and "there is no pane" is different from
     * "the pane is sitting on a prompt".
     */
    const why = async (what: string) => {
      const screen = await captureOrGone(win.windowId);
      return { ok: false, out: screen === null ? `${what} — and the window is already gone` : `${what}${paneTail(screen)}` };
    };

    if (!(await waitReady(win.windowId, Math.min(deadline, Date.now() + READY_TIMEOUT_MS)))) {
      return await why(`the chat pane never became ready in ${Math.round(READY_TIMEOUT_MS / 1000)}s`);
    }
    if (!(await pasteRaw(win.windowId, p.prompt))) {
      return await why("could not write the brief into the pane");
    }
    const pasted = await waitPasted(win.windowId, Math.min(deadline, Date.now() + PASTE_TIMEOUT_MS));
    if (pasted === null) {
      return await why("the brief never landed in the chat pane's input box");
    }
    const outcome = await submitConfirmed(win.windowId, pasted, Math.min(deadline, Date.now() + PASTE_TIMEOUT_MS));
    if (outcome !== "sent") {
      // "queued" cannot happen — this is a freshly started session with
      // nothing else running in it — so this is "stuck" or "diverted" in
      // practice: the brief sat in the box, or opened something that needs a
      // person. Either way the run cannot continue unattended.
      return {
        ok: false,
        out: `the pane would not take the brief (${outcome}); it may be waiting on a prompt only a person can answer`,
      };
    }

    const transcript = agent.transcriptFor(p.cwd, sessionId, home ?? undefined);
    let offset = 0;
    let carry = "";
    /* When the prompt now on screen was FIRST seen, or 0 for "none up". The
       turn's own clock, and not the transcript's. */
    let promptSince = 0;
    // What it actually said, accumulated as the turn writes it — never the
    // tool calls in between, the same as `-p`'s own closing `result` field.
    const texts: string[] = [];
    // The most recent screen this run actually managed to capture. Checked
    // every tick rather than only on a stall: a process that dies in under a
    // minute takes its window with it (no `remain-on-exit`), and by the time
    // a stall would have been noticed the window is long gone — this is the
    // only way to have caught its last words at all.
    let lastScreen = "";
    /* The quiet clock: reset by a growing transcript or a changed signature. */
    let quietSince = Date.now();
    let lastSig = "";
    let warnedQuiet = false;

    for (;;) {
      if (Date.now() > deadline) {
        const fresh = await captureOrGone(win.windowId);
        return {
          ok: false,
          out: `${texts.join("\n").trim()}\n--- it ran out of time and was stopped ---${paneTail(fresh ?? lastScreen)}`.trim().slice(-8000),
        };
      }
      const size = await sizeOf(transcript);
      if (size > offset) {
        quietSince = Date.now();
        const chunk = await Bun.file(transcript).slice(offset, size).text();
        offset = size;
        const lines = (carry + chunk).split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let o: Record<string, unknown>;
          try { o = JSON.parse(line); } catch { continue; }
          if (agent.isTurnEnd(o)) {
            const out = texts.join("\n").trim();
            return { ok: out.length > 0, out: out.slice(-8000) };
          }
          if (o.type === "assistant") {
            const msg = o.message as { content?: { type?: string; text?: string }[] } | undefined;
            for (const block of msg?.content ?? []) {
              if (block?.type === "text" && block.text) texts.push(block.text);
            }
          }
        }
      }

      const screen = await captureOrGone(win.windowId);
      if (screen === null) {
        return {
          ok: false,
          out: `${texts.join("\n").trim()}\n--- the chat pane exited before the turn finished ---${paneTail(lastScreen)}`.trim().slice(-8000),
        };
      }
      lastScreen = screen;
      const sig = screenSignature(screen);
      if (sig !== lastSig) { lastSig = sig; quietSince = Date.now(); }
      const quietFor = Date.now() - quietSince;
      if (!__needsYou(screen) && quietFor > QUIET_STOP_MS) {
        const m = Math.round(quietFor / 60_000);
        return {
          ok: false,
          out: `${texts.join("\n").trim()}\n--- it went quiet: no new output and no transcript for ${m} min, and was stopped ---${paneTail(screen)}`.trim().slice(-8000),
        };
      }
      if (!__needsYou(screen) && quietFor > QUIET_WARN_MS && !warnedQuiet) {
        warnedQuiet = true;
        const m = Math.round(quietFor / 60_000);
        p.onQuiet?.(quietFor);
        pushUnderstudyStuck(p.label, `has been quiet for ${m} min — no new output, no transcript.`,
          `nothing yet; it is stopped at ${Math.round(QUIET_STOP_MS / 60_000)} min if nothing changes`);
      }

      /*
       * A PROMPT THAT IS STILL THERE, which is not the same question as a
       * transcript that has stopped growing.
       *
       * This used to look at the screen only after the transcript had been
       * quiet for `STALL_CHECK_MS`, and the two come apart exactly where it
       * hurts. Measured on an isolated server against a stub holding the same
       * permission prompt on screen, budget 60s:
       *
       *     transcript quiet     caught at 8.98s, and named for what it was
       *     transcript growing   ran the whole budget — 45 minutes in a real
       *                          run — and the outcome never says a prompt was
       *                          ever on screen
       *
       * Anything still writing while a prompt is up puts a run in the second
       * row: a subagent finishing its own work, a hook, a buffered flush
       * landing late. The turn is equally stuck either way — nobody is going to
       * answer it — but the clock gets spent before anybody is told, and the
       * reason is gone by the time they are.
       *
       * So the wait is on the prompt itself: seen once, then still there
       * `STALL_CHECK_MS` later. That keeps the whole false-positive guard the
       * old gate existed for, and drops the part that was never load-bearing,
       * which is what the transcript happened to be doing meanwhile.
       */
      if (__needsYou(screen)) {
        if (promptSince === 0) promptSince = Date.now();
        else if (Date.now() - promptSince > STALL_CHECK_MS) {
          return {
            ok: false,
            out: "this opened an interactive prompt only a person can answer, and nobody is watching this pane to give one",
          };
        }
      } else promptSince = 0;
      await Bun.sleep(200);
    }
  } finally {
    // Every ending, including the ones nobody wrote a branch for — see
    // runAgentInPane, which the same sentence already lives on.
    await endLease(win.windowId);
  }
}
