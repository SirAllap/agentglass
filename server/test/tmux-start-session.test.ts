/*
 * A fixture session made right after the last one was killed.
 *
 * tmux ends a server whose last session goes, and it does so after the client
 * that asked has already returned. A `new-session` in that gap connects to a
 * server on its way out and fails with "server exited unexpectedly" — or, after
 * `kill-server`, "no server running". The suites that kill their session at the
 * end of one test and make it again at the start of the next hit that gap on a
 * busy machine and on nothing else, which is why they failed only inside the
 * full run and never alone. Measured with the raw CLI: 131 of 300 immediate
 * re-creations failed after `kill-session`, 67 of 300 after `kill-server`.
 *
 * `startSession` is the fixture's answer, and this holds it to it: the same
 * loop, through the helper, never loses a session.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TMUX_ISOLATED, startSession } from "./tmuxIsolated.ts";

const HAVE_TMUX = !!Bun.which("tmux");
// Short on purpose: a Unix socket path over 107 bytes is refused outright.
const dir = mkdtempSync(join("/tmp", "agx-start-"));
const env = { ...process.env, TMUX: undefined, TMUX_TMPDIR: dir };
const T = ["tmux", ...TMUX_ISOLATED, "-L", "agx-start"];
const run = (...args: string[]) => Bun.spawnSync([...T, ...args], { env, stdout: "ignore", stderr: "ignore" });

afterAll(() => {
  run("kill-server");
  rmSync(dir, { recursive: true, force: true });
});

describe.if(HAVE_TMUX)("a session made on a server that is still going down", () => {
  test("is there every time, after the last session was killed", () => {
    for (let i = 0; i < 40; i++) {
      startSession([...T, "new-session", "-d", "-s", "fixture", "sleep", "300"], env);
      expect(run("has-session", "-t", "=fixture").exitCode, `lost on round ${i}`).toBe(0);
      run("kill-session", "-t", "=fixture");
    }
  });

  test("and after the whole server was killed", () => {
    for (let i = 0; i < 40; i++) {
      run("kill-server");
      startSession([...T, "new-session", "-d", "-s", "fixture", "sleep", "300"], env);
      expect(run("has-session", "-t", "=fixture").exitCode, `lost on round ${i}`).toBe(0);
    }
  });

  test("and says so when tmux will never make it, rather than spinning", () => {
    expect(() => startSession([...T, "new-session", "-d", "-s", "fixture", "--no-such-flag"], env, 3))
      .toThrow(/new-session/);
  });
});
