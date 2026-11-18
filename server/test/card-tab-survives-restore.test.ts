/*
 * A CARD'S TAB COMES BACK STILL BEING THE CARD'S TAB.
 *
 * A restore rebuilds a window from its recorded name and directory. A tab
 * somebody renamed to `my notes` came back as `my notes` with nothing saying
 * which card it was, so the next hand-off of that card no longer recognised it
 * and opened a second tab beside it. The pin agentglass puts on the window has
 * to be photographed and put back with the rest of the window.
 *
 * Real tmux, on a socket, a temporary directory and a state dir of this file's
 * own. The server is killed outright between the photograph and the restore,
 * which is the case a reboot is.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settled } from "./paneSettled.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const SOCKET = `agx-cardrestore-${process.pid}`;
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const REAL_STATE = process.env.AGENTGLASS_STATE_DIR;
const REAL_TMUX = process.env.TMUX;
delete process.env.TMUX;
const STATE = mkdtempSync(join(tmpdir(), `agx-cardrestore-${process.pid}-state-`));
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;
process.env.AGENTGLASS_STATE_DIR = STATE;

const { engineWindowOutcome, liveWindows, tmux, tmuxCapability } = await import("../src/tmuxpane.ts");
const { captureLayout, restoreLayout } = await import("../src/tmuxrestore.ts");

let dir = "";
const have = tmuxCapability().available;

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agx-cardrestore-")); });
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
  if (REAL_TMUX === undefined) delete process.env.TMUX;
  else process.env.TMUX = REAL_TMUX;
});

describe("a card's tab after a restore", () => {
  it.skipIf(!have)("comes back renamed, still pinned to its card, and is found again", async () => {
    const w = await engineWindowOutcome(dir, "orbit-ORBIT-1042", ["sh", "-c", "sleep 30"], dir, undefined, undefined, false, true, false, "ORBIT-1042");
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    await settled(async () => (await liveWindows()).find((x) => x.windowId === w.windowId)?.path, (p) => p === dir);
    expect((await tmux(["rename-window", "-t", w.windowId, "my notes"])).ok).toBe(true);

    const photo = await captureLayout(Date.now());
    const captured = photo?.sessions.flatMap((s) => s.windows).find((x) => x.name === "my notes");
    expect(captured?.given).toBe("orbit-ORBIT-1042");
    expect(captured?.card).toBe("ORBIT-1042");

    /* The server dies and the desk is put back from the photograph. */
    expect((await tmux(["kill-server"])).ok).toBe(true);
    expect((await restoreLayout("lazy")).ok).toBe(true);

    /* A restored window's name is set by tmux's loop after the command returns: wait for it. */
    const back = await settled(async () => (await liveWindows()).find((x) => x.name === "my notes"), (x) => !!x);
    expect(back?.given).toBe("orbit-ORBIT-1042");
    expect(back?.card).toBe("ORBIT-1042");

    const again = await engineWindowOutcome(dir, "orbit-ORBIT-1042", ["sh", "-c", "sleep 30"], dir, undefined, undefined, false, true, false, "ORBIT-1042");
    expect(again.ok && again.reused).toBe(true);
    expect(again.ok ? again.windowId : "").toBe(back?.windowId ?? "");
    const names = await settled(async () => (await liveWindows()).map((x) => x.name), (n) => !n.includes("orbit-ORBIT-1042"));
    expect(names).not.toContain("orbit-ORBIT-1042");
    expect(names).toContain("my notes");
  }, 20_000);
});
