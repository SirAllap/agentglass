/*
 * Nothing opens a socket to a port that is not listening yet.
 *
 * Two sockets fire while the sidecar is still booting, and Chromium logs a
 * refused one whether or not the reconnect picks it up — the same reason the
 * fetch layer stopped asking early. `/stream` was measured: created at 1719ms,
 * handshake 101, once. `/terminal/pty` was seen in his console
 * (`ws://127.0.0.1:4000/terminal/pty?root=…` refused) but could NOT be
 * reproduced on a rig: a fresh profile has no project chosen, so the panel
 * mounts no session and never opens a pty. It is guarded here instead, and his
 * next cold start is the real test.
 *
 * WHY THE GATE IS AT THE CALL SITE AND NOT INSIDE THE CONNECT FUNCTION.
 * Putting an await inside `useLive`'s `connect` opened a window between
 * deciding to connect and assigning `wsRef.current`, and three things
 * reconnect on their own in that gap. Two sockets. `onclose` survives it
 * (`wsRef.current !== ws`), `onmessage` checks nothing, so BOTH deliver and
 * every frame is handled twice — an agent's browser command run twice, a
 * phone's toggle applied and undone. Not console noise. The rule that came out
 * of it: the wait goes where the connection is DECIDED, never between the
 * decision and the assignment that guards it.
 *
 * These are source assertions because the alternative needs Electron, a guest,
 * a project and a tmux pane. What they hold is the shape that made the bug
 * possible, which is the part a render test would not see either.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
/** Comments name the very things these assertions are about — an absence check
 *  trips over the note explaining why the thing is forbidden. */
const bare = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the live socket", () => {
  const src = read("lib/useLive.ts");

  test("waits for a server before the first connection", () => {
    expect(bare(src)).toContain("whenServerUp()");
  });

  test("and `connect` stays synchronous", () => {
    // The whole bug in one assertion. An async connect is two sockets.
    expect(bare(src), "connect must not be async").not.toMatch(/const connect = useCallback\(async/);
  });

  test("the first connection is claimed before it is opened", () => {
    // `!wsRef.current` is what stops a tab that woke during the wait from
    // opening a second one, and `then(go, go)` is what stops a rejected latch
    // from leaving the app alive and mute.
    const b = bare(src);
    expect(b).toContain("!wsRef.current");
    expect(b).toMatch(/whenServerUp\(\)\.then\((\w+),\s*\1\)/);
  });
});

describe("the terminal socket", () => {
  const src = read("components/TerminalPanel.tsx");

  test("waits for a server before the first shell", () => {
    expect(bare(src)).toContain("whenServerUp()");
  });

  test("every boot-time connect is behind the gate", () => {
    /* Counted, not matched against the whole file: the gated form CONTAINS the
       bare one (`const go = () => { if (s.status === "idle") connect(s); }`),
       so a plain `not.toContain` reports a failure that is not there — and
       prints the entire component while doing it. What is actually forbidden
       is that statement standing on a line of its own. */
    const bareCalls = bare(src)
      .split("\n")
      .filter((l) => /if \(s\.status === "idle"\) connect\(s\);/.test(l))
      .filter((l) => !/const go = \(\) =>/.test(l));
    expect(bareCalls, "every boot connect goes through the gate").toEqual([]);
    const gated = [...bare(src).matchAll(/whenServerUp\(\)\.then\((\w+),\s*\1\)/g)];
    expect(gated.length, "both mount paths are gated").toBeGreaterThanOrEqual(2);
  });

  test("and the status is re-read after the wait", () => {
    // A session connected while the gate was open must not be connected twice.
    // `connect`'s own `s.ws` guard would catch it, but reading the status again
    // is what makes that guard reachable rather than incidental.
    expect(/const go = \(\) => \{ if \(s\.status === "idle"\) connect\(s\); \};/.test(bare(src)),
      "the status is read again inside the deferred call").toBe(true);
  });
});

describe("what the gate must not become", () => {
  const api = read("lib/api.ts");

  test("it asks the shell, never the network", () => {
    const b = bare(api);
    // The probe it replaced was one refused /health per launch. If it comes
    // back, so does the error this whole change removed.
    expect(b).toContain("SHELL.sidecarUp?.()");
    expect(b, "no probeServer inside whenServerUp")
      .not.toMatch(/serverUp = \(async \(\) => \{[\s\S]{0,400}probeServer\(/);
  });

  test("and it reads a verdict that has already been reached", () => {
    // A window opened after the shell gave up has missed the event, and
    // waiting for it means sitting out the whole timeout before showing the
    // banner the error it already has.
    expect(bare(api)).toContain("SHELL.sidecarFailure");
  });
});
