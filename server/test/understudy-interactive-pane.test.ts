/*
 * The interactive pane a run gets before it falls back to `-p`.
 *
 * `runAgentInPane` (index.ts) is asserted against its own source text — see
 * understudy-watch-run.test.ts — rather than by opening a real window,
 * because each property under test belongs to the COMMAND that is built and
 * a suite that needed tmux would be skipped on the machine where it matters
 * most. `runAgentInteractivePane` is the same shape of function for the same
 * reason, so it is held to the same style of test here.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/understudy-pane.ts", import.meta.url)).text();
const indexSrc = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

describe("what it takes before it commits to a window", () => {
  test("no tmux, or no claude binary, and it is null — never a throw", () => {
    const from = src.indexOf("export async function runAgentInteractivePane(");
    const body = src.slice(from, src.indexOf("\n}\n", from));
    const guard = body.slice(0, body.indexOf("const sessionId"));
    expect(guard).toContain("tmuxCapability()");
    expect(guard).toContain("return null");
    expect(guard).toContain("agent.bin()");
  });

  test("a window that would not open is also null, before anything is leased", () => {
    const from = src.indexOf("export async function runAgentInteractivePane(");
    const body = src.slice(from, src.indexOf("\n}\n", from));
    const beforeLease = body.slice(0, body.indexOf("takeLease("));
    expect(beforeLease).toContain("if (!win) return null;");
  });
});

describe("once a window opens, it is leased before anything is typed into it", () => {
  test("the lease call sits between opening the window and pasting the brief", () => {
    const bodyFrom = src.indexOf("export async function runAgentInteractivePane(");
    const openAt = src.indexOf("engineWindowRunning(", bodyFrom);
    const leaseAt = src.indexOf("takeLease(", bodyFrom);
    const pasteAt = src.indexOf("await pasteRaw(", bodyFrom);
    expect(openAt).toBeGreaterThan(-1);
    expect(leaseAt).toBeGreaterThan(openAt);
    expect(pasteAt).toBeGreaterThan(leaseAt);
  });

  test("every exit goes through endLease, success or not", () => {
    const from = src.indexOf("export async function runAgentInteractivePane(");
    const body = src.slice(from, src.indexOf("\n}\n", from));
    expect(body).toContain("} finally {");
    expect(body.slice(body.indexOf("} finally {"))).toContain("endLease(win.windowId)");
  });
});

describe("turn end comes from the transcript, never from the screen", () => {
  test("the loop reads agent.isTurnEnd, the explicit marker paneagent.ts asks for", () => {
    expect(src).toContain("agent.isTurnEnd(o)");
  });

  test("only assistant text is kept as the outcome, not tool noise", () => {
    const from = src.indexOf("if (o.type === \"assistant\")");
    expect(from).toBeGreaterThan(-1);
    // Bounded by the brace that closes that branch, not by a character count:
    // a comment added inside it must not move what this test can see.
    const branch = src.slice(from, src.indexOf("\n          }", from));
    expect(branch).toContain('block?.type === "text"');
  });
});

describe("the fresh session is launched interactively, not with -p", () => {
  test("fresh: true, and no -p in the argv it builds", () => {
    const from = src.indexOf("agent.argv({");
    const call = src.slice(from, src.indexOf("});", from));
    expect(call).toContain("fresh: true");
    expect(call).toContain('mode: "bypassPermissions"');
  });
});

describe("a bad ending carries what was on screen, same as runAgentInPane does", () => {
  test("the exact sentence is unchanged — it is the only thing three dead runs left behind", () => {
    expect(src).toContain("the chat pane exited before the turn finished");
  });

  test("that ending is followed by a captured tail, not silence", () => {
    const from = src.indexOf('--- the chat pane exited before the turn finished ---');
    expect(from).toBeGreaterThan(-1);
    const line = src.slice(from, src.indexOf("\n", from));
    expect(line).toContain("paneTail(lastScreen)");
  });

  test("a timeout also carries a tail, captured fresh rather than reused stale", () => {
    const from = src.indexOf('--- it ran out of time and was stopped ---');
    expect(from).toBeGreaterThan(-1);
    const line = src.slice(from, src.indexOf("\n", from));
    expect(line).toContain("paneTail(fresh ?? lastScreen)");
  });

  test("the tail is captured every tick, not only after a stall — a death under a minute cannot wait 15s to be noticed", () => {
    const loopFrom = src.indexOf("for (;;) {", src.indexOf("export async function runAgentInteractivePane("));
    const loopBody = src.slice(loopFrom, src.indexOf("\n  } finally {", loopFrom));
    const captureAt = loopBody.indexOf("captureOrGone(win.windowId)");
    const stallGateAt = loopBody.indexOf("STALL_CHECK_MS");
    expect(captureAt).toBeGreaterThan(-1);
    // The capture call sits before the stall gate, unconditioned by it.
    expect(captureAt).toBeLessThan(stallGateAt);
  });

  test("says so explicitly when there was never anything to capture, rather than an empty tail", () => {
    const from = src.indexOf("function paneTail(");
    const body = src.slice(from, src.indexOf("\n}", from));
    expect(body).toContain("already gone");
  });
});

describe("the caller commits to one rung before trying the next", () => {
  test("the interactive pane is tried first, and only its own null falls through", () => {
    const from = indexSrc.indexOf("async function runAgentIn(");
    const fn = indexSrc.slice(from, indexSrc.indexOf("\n}\n", from));
    const interactiveAt = fn.indexOf("runAgentInteractivePane({");
    const watchedAt = fn.indexOf("runAgentInPane({");
    const spawnAt = fn.indexOf("Bun.spawn(argv");
    expect(interactiveAt).toBeGreaterThan(-1);
    expect(watchedAt).toBeGreaterThan(interactiveAt);
    expect(spawnAt).toBeGreaterThan(watchedAt);
    expect(fn.slice(interactiveAt, watchedAt)).toContain("if (interactive) return interactive;");
  });

  test("it is handed the chosen model and effort, the same ones -p would get", () => {
    const from = indexSrc.indexOf("runAgentInteractivePane({");
    const call = indexSrc.slice(from, indexSrc.indexOf("});", from));
    expect(call).toContain("model: pick.model");
    expect(call).toContain("effort: pick.effort");
  });
});
