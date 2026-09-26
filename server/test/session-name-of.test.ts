/*
 * `sessionNameOf` resolves a `$id` to whatever the session is named RIGHT NOW.
 *
 * Written for cmd:"agent" opening a phone's new window into a fresh session
 * named after the repo (`orbit`) instead of the desk session the phone's
 * mirror is grouped with (`qa`) — the fix reads that session by the $id tmux
 * groups the mirror onto, `PhoneAttach.sessionId`, and needs a name to hand a
 * session-targeting tmux command. Measured against a real, isolated tmux: a
 * session named something other than its `$id` (tmux assigns ids in creation
 * order, not alphabetically) so a wrong implementation that returned the id
 * itself would still fail.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const SOCKET_NAME = `agx-sessionnameof-${process.pid}`;

// TMUX_TMPDIR is set in beforeAll and put back in afterAll, never at import:
// every test file shares one process, and a variable assigned at import time
// is still assigned while the OTHER files run — that sent
// engine-window-no-empty's tmux to this file's socket and failed it in the
// full suite while it passed alone. `sessionNameOf` takes its socket as an
// argument, so AGENTGLASS_TMUX_SOCKET is not touched at all.
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const { sessionNameOf } = await import("../src/tmuxctl.ts");

const socket = ["-f", "/dev/null", "-L", SOCKET_NAME];

function tmux(args: string[]): { stdout: string; exitCode: number } {
  const { TMUX: _dropped, ...env } = process.env;
  const r = Bun.spawnSync(["tmux", ...socket, ...args], {
    stdout: "pipe", stderr: "pipe", env: { ...env, TMUX_TMPDIR: TMUX_TEST_TMPDIR },
  });
  return { stdout: r.stdout.toString(), exitCode: r.exitCode ?? 1 };
}

const have = Bun.spawnSync(["tmux", "-V"]).exitCode === 0;

beforeAll(() => {
  process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;
  if (!have) return;
  // Two sessions, so tmux's own id order (creation order) does not happen to
  // match either name — the case a naive "return the id" bug would still pass.
  tmux(["new-session", "-d", "-s", "orbit"]);
  tmux(["new-session", "-d", "-s", "qa"]);
});

afterAll(() => {
  if (have) tmux(["kill-server"]);
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
});

describe("sessionNameOf", () => {
  it("resolves a session's current name from its $id", () => {
    if (!have) return;
    const rows = tmux(["list-sessions", "-F", "#{session_name}\t#{session_id}"]).stdout
      .trim().split("\n").map((l) => l.split("\t"));
    const qaId = rows.find(([name]) => name === "qa")?.[1];
    expect(qaId).toMatch(/^\$\d+$/);
    expect(sessionNameOf(socket, qaId!)).toBe("qa");
  });

  it("follows a rename, because a stale name is the whole bug", () => {
    if (!have) return;
    const rows = tmux(["list-sessions", "-F", "#{session_name}\t#{session_id}"]).stdout
      .trim().split("\n").map((l) => l.split("\t"));
    const id = rows.find(([name]) => name === "orbit")?.[1];
    if (!id) throw new Error("the orbit session was not listed");
    tmux(["rename-session", "-t", "orbit", "orbit-renamed"]);
    expect(sessionNameOf(socket, id)).toBe("orbit-renamed");
  });

  it("returns null for an id no server here has", () => {
    if (!have) return;
    expect(sessionNameOf(socket, "$999")).toBeNull();
  });
});
