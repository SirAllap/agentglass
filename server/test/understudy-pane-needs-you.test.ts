/*
 * A run died on "this opened an interactive prompt only a person can answer,
 * and nobody is watching this pane to give one" — five minutes lost, the task
 * back in the queue. What it hit was self-inflicted: the brief itself told an
 * unattended run to type `/model` or `/effort` into its own pane mid-task,
 * "the way he does". In HIS chat that is safe — chatpane.ts kills and
 * relaunches the pane with new argv flags. In this pane there is no such
 * relaunch; typing either command draws the CLI's own picker (a real capture
 * of one lives in chat-pane.test.ts as `MODEL_PICKER`), which waits on an
 * arrow key nobody will ever send.
 *
 * Two fixes: stop telling it to do the thing that hangs, and — since a run
 * could still wander into some other prompt nobody has named yet — make the
 * detector that already exists (`__needsYou`, chatpane.ts) close the run
 * quickly instead of sitting on it for a quarter of a minute.
 */
import { describe, expect, test } from "bun:test";
import { __needsYou } from "../src/chatpane.ts";

const workSrc = await Bun.file(new URL("../src/understudy-work.ts", import.meta.url)).text();
const paneSrc = await Bun.file(new URL("../src/understudy-pane.ts", import.meta.url)).text();

describe("the brief no longer tells a run to do the thing that hangs it", () => {
  test("nothing in it instructs typing /model or /effort into the pane mid-task", () => {
    expect(workSrc).not.toContain("If `/model` and `/effort` do something when you type them, use them on");
    expect(workSrc).not.toContain("yourself mid-task the way he does");
  });

  test("it says plainly not to, and why", () => {
    const from = workSrc.indexOf("SPEND THE ALLOWANCE THE WAY THE OWNER DOES:");
    const to = workSrc.indexOf("WHAT YOU CAN REACH", from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const section = workSrc.slice(from, to);
    expect(section).toContain("do NOT type `/model` or `/effort`");
    expect(section).toContain("picker");
  });
});

describe("if a run finds some other prompt nobody has named yet, it still closes fast", () => {
  test("the wait before __needsYou closes a run is under ten seconds", () => {
    /* The DEFAULT, read past the env override the constant now carries: a test
       that runs with `AGENTGLASS_PANE_STALL_CHECK_MS` set is measuring its own
       environment, and this claim is about what ships. */
    const from = paneSrc.indexOf("const STALL_CHECK_MS");
    const line = paneSrc.slice(from, paneSrc.indexOf("\n", from));
    const ms = Number(line.match(/\?\?\s*([\d_]+)/)?.[1]?.replaceAll("_", ""));
    expect(ms, line).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  test("the main loop waits on the PROMPT, gated on that same constant", () => {
    /*
     * Rewritten when the gate moved off transcript growth and onto the screen.
     * The old wording asserted `Date.now() - lastGrowth > STALL_CHECK_MS`,
     * which was the bug: a run whose transcript kept growing while a prompt sat
     * on screen was never looked at, and spent its whole 45 minutes. Measured —
     * 8.98s when the transcript was quiet, the entire budget when it was not.
     *
     * What has to stay true is the pair: the loop looks at the screen, and it
     * waits on the same constant before acting. `pane-prompt-while-talking`
     * holds the behaviour itself against a real tmux; this holds the shape, so
     * a second timer cannot quietly appear beside the first.
     */
    const loopFrom = paneSrc.indexOf("for (;;) {", paneSrc.indexOf("export async function runAgentInteractivePane("));
    const loopBody = paneSrc.slice(loopFrom, paneSrc.indexOf("\n  } finally {", loopFrom));
    expect(loopBody).toContain("__needsYou(screen)");
    expect(loopBody).toContain("promptSince > STALL_CHECK_MS");
    // And not gated on the transcript any more, which is the regression.
    expect(loopBody).not.toContain("lastGrowth");
  });
});

describe("the detector itself catches the exact prompt that killed the run", () => {
  // A real capture of what typing a bare `/model` draws — the same fixture
  // shape as chat-pane.test.ts's MODEL_PICKER, reproduced here as the fake
  // output this lock has to bite on.
  const MODEL_PICKER = [
    "   Select model",
    "   Switch between Claude models. Your pick becomes the default for new sessions.",
    "     1. Default (recommended)  Opus 5 with 1M context",
    "     4. Sonnet                 Sonnet 5 · Efficient for routine tasks",
    "   ❯ 5. Haiku ✔                Haiku 4.5 · Fastest for quick answers",
    "   Enter to set as default · s to use this session only · Esc to cancel",
  ].join("\n");

  const EFFORT_PICKER = [
    "❯ /effort",
    "   Effort",
    "   low   medium   high   xhigh   max",
    "   ←/→ to adjust · Enter to confirm · Esc to cancel",
  ].join("\n");

  test("the /model picker reads as needing a person", () => {
    expect(__needsYou(MODEL_PICKER)).toBe(true);
  });

  test("the /effort picker reads as needing a person", () => {
    expect(__needsYou(EFFORT_PICKER)).toBe(true);
  });

  test("a turn genuinely still working is never mistaken for one", () => {
    expect(__needsYou("● Reading files…\n✻ Brewed for 94s (esc to interrupt)")).toBe(false);
  });
});
