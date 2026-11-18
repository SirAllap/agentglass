/*
 * A STOP THAT COULD NOT CLOSE THE WINDOW MUST NOT REAP WHAT IS STILL IN IT.
 *
 * `stopAgent` used to reap whenever it was asked to kill, and the only thing
 * standing between a live worker and its processes was a comment claiming the
 * window was gone by that line. It is not when `kill-window` fails — a tmux
 * client the server will not speak to is the shape of that, and the read path
 * already treats it as "unknown" (`reaper-fails-closed.test.ts`). The reap runs
 * with no liveness question and no age gate, so it SIGTERMs the worker's
 * `nohup`'d child and removes its `TMPDIR` under the worker still writing there.
 *
 * Two runs: a window that will not close, whose scratch must survive, and a
 * window that does close, which is the guard against fixing it by never reaping.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NamedAgent } from "../src/agentops.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const NAME = `agx-probestop-${process.pid}`;
const SOCKET = `${NAME}-sock`;
const STATE = mkdtempSync(join(tmpdir(), `${NAME}-state-`));
const REAL = {
  sock: process.env.AGENTGLASS_TMUX_SOCKET,
  tmpdir: process.env.TMUX_TMPDIR,
  state: process.env.AGENTGLASS_STATE_DIR,
  tmuxPath: process.env.AGENTGLASS_TMUX_PATH,
};
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;
process.env.AGENTGLASS_STATE_DIR = STATE;

const ops = await import("../src/agentops.ts");
const { ownerLaunch, ownerTmpDir } = await import("../src/reaper.ts");

/** A tmux that cannot answer, and one that answers every call with success.
 *  The obeying one says the pane is this worker's own (`#{pane_pid}\t#{@agx_owner}`):
 *  stopAgent closes only a window it owns, asked on the pane at the kill. */
const stub = (name: string, body: string): string => {
  const path = join(STATE, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
const BROKEN = stub("broken-tmux", "echo 'server exited unexpectedly' >&2\nexit 1");
const OBEYS = stub("obeying-tmux", `case "$*" in *display-message*) printf '4242\\t%s\\n' '${NAME}';; esac\nexit 0`);

const agent = (): NamedAgent => ({
  name: NAME, kind: "claude", cwd: STATE, paneId: "%1", windowId: "@1", startedAt: Date.now(), endedAt: null,
});

/** A scratch with something in it, the way a running worker has one. */
function scratchOf(): string {
  const launched = ownerLaunch(NAME);
  if (!launched.dir) throw new Error("the owner name was refused");
  writeFileSync(join(launched.dir, "still-writing"), "x");
  return launched.dir;
}

async function vanish(path: string, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!existsSync(path)) return true;
    await Bun.sleep(25);
  }
  return !existsSync(path);
}

afterAll(() => {
  try { rmSync(ownerTmpDir(NAME)!, { recursive: true, force: true }); } catch { /* never made */ }
  rmSync(STATE, { recursive: true, force: true });
  for (const [k, v] of [
    ["AGENTGLASS_TMUX_SOCKET", REAL.sock],
    ["TMUX_TMPDIR", REAL.tmpdir],
    ["AGENTGLASS_STATE_DIR", REAL.state],
    ["AGENTGLASS_TMUX_PATH", REAL.tmuxPath],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("a stop whose kill-window failed", () => {
  test("keeps the worker's scratch, because the window is still there", async () => {
    process.env.AGENTGLASS_TMUX_PATH = BROKEN;
    const dir = scratchOf();
    const result = await ops.stopAgent(agent(), Date.now(), true);
    /* The premise: the kill did not happen, so neither did the end of the
       window the reap is supposed to be the net under. */
    expect(result.killed).toBe(false);
    await Bun.sleep(600);
    expect(existsSync(join(dir, "still-writing")), "a reuse of a live worker's TMPDIR").toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("still reaps one whose window did close", async () => {
    process.env.AGENTGLASS_TMUX_PATH = OBEYS;
    const dir = scratchOf();
    const result = await ops.stopAgent(agent(), Date.now(), true);
    expect(result.killed).toBe(true);
    expect(await vanish(dir), "nothing was reaped for a window that did close").toBe(true);
  });

  test("lets go of an enlisted tab without reaping it, whatever the kill says", async () => {
    process.env.AGENTGLASS_TMUX_PATH = OBEYS;
    const dir = scratchOf();
    /* `kill: false` is the default for an adopted row, and its processes are
       the person's: the scratch goes when they close the tab, not here. */
    const result = await ops.stopAgent({ ...agent(), adopted: true });
    expect(result.killed).toBe(false);
    await Bun.sleep(600);
    expect(existsSync(dir), "a person's own tab was reaped").toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
