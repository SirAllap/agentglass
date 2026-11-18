/*
 * A LIVE WORKER'S WINDOW IS NOT ITS NAME.
 *
 * Liveness for the sweep was "is there a window on the engine called the owner's
 * name". Two ordinary things break that: a person renames the tab, and a name
 * with a dot in it is rewritten to a dash before the window is made
 * (`engineWindowName`), so the tag never equals the window name at all. In both
 * cases a working agent became "an owner whose window is gone" the moment its
 * registry row ended, and the ten-minute sweep then SIGTERMed its `nohup`'d dev
 * server and removed the `TMPDIR` it was writing in.
 *
 * So the owner is pinned to the window as a tmux option at launch, and liveness
 * reads that as well. A real tmux, isolated on its own socket: the whole point
 * is what a rename does to a name, and a table cannot say that.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const SOCKET = `agx-reaperrename-${process.pid}`;
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const REAL_STATE = process.env.AGENTGLASS_STATE_DIR;
/* `agentops.ts` opens the registry database on import: a test that asked it
   liveness questions against the real one would read somebody's rows. */
const STATE = mkdtempSync(join(tmpdir(), `agx-reaperrename-${process.pid}-state-`));
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;
process.env.AGENTGLASS_STATE_DIR = STATE;

const { engineWindowRunning, tmux, tmuxCapability } = await import("../src/tmuxpane.ts");
const ops = await import("../src/agentops.ts");

let dir = "";
const have = tmuxCapability().available;

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agx-reaperrename-")); });
afterAll(async () => {
  if (have) await tmux(["kill-server"]);
  if (dir) rmSync(dir, { recursive: true, force: true });
  rmSync(STATE, { recursive: true, force: true });
  if (REAL_SOCKET === undefined) delete process.env.AGENTGLASS_TMUX_SOCKET;
  else process.env.AGENTGLASS_TMUX_SOCKET = REAL_SOCKET;
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  if (REAL_STATE === undefined) delete process.env.AGENTGLASS_STATE_DIR;
  else process.env.AGENTGLASS_STATE_DIR = REAL_STATE;
});

describe("a worker's window under a name that changed", () => {
  it("is still live after a person renamed its tab", async () => {
    if (!have) return;
    const w = await engineWindowRunning(dir, "probe-renamed", ["sh", "-c", "sleep 30"]);
    expect(w).not.toBeNull();
    expect((await ops.liveOwnerNames())?.has("probe-renamed")).toBe(true);
    expect((await tmux(["rename-window", "-t", w!.windowId, "renamed-by-hand"])).ok).toBe(true);
    /* The premise: the name the sweep used to look for is gone. */
    const names = (await tmux(["list-windows", "-a", "-F", "#{window_name}"])).stdout;
    expect(names).not.toContain("probe-renamed");
    expect(names).toContain("renamed-by-hand");
    expect((await ops.liveOwnerNames())?.has("probe-renamed"), "a renamed tab is a live worker's leftovers").toBe(true);
  });

  it("is still live when its name had a dot the window could not keep", async () => {
    if (!have) return;
    /* What `startAgent` does: the raw name is the owner, and the window is
       named through `engineWindowName`, which rewrites the dot. */
    const w = await engineWindowRunning(dir, "proj1.2", ["sh", "-c", "sleep 30"], dir, { AGX_OWNER: "proj1.2" });
    expect(w).not.toBeNull();
    const names = (await tmux(["list-windows", "-a", "-F", "#{window_name}"])).stdout;
    expect(names).toContain("proj1-2");
    expect(names).not.toContain("proj1.2");
    expect((await ops.liveOwnerNames())?.has("proj1.2"), "the tab is on the engine under another name").toBe(true);
  });

  it("does not vouch for an owner no window carries", async () => {
    if (!have) return;
    /* The guard against pinning everything: a name nobody is using is still a
       gone owner, which is what lets the sweep collect its leftovers. */
    expect((await ops.liveOwnerNames())?.has("probe-never-launched")).toBe(false);
  });
});
