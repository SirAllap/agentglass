/*
 * A CARD'S TAB IS NAMED AFTER ITS JIRA KEY, AND A NAME YOU GAVE IT STAYS.
 *
 * `orbit-ORBIT-1042` is the name people say out loud, so it is the name the tab
 * carries, and tmux is told not to rename it from the program inside.
 *
 * The second half is the one that is easy to get wrong. The card's tab is found
 * again by its name — a card asks "is this already open" — and a person who
 * renamed the tab (`my notes`) then got a SECOND tab under the card's name
 * beside it, which reads as the app renaming their tab back. So the name
 * agentglass gave a window is pinned on the window as a tmux option and the
 * lookup accepts either: what the tab shows, or what it was made as. Nothing is
 * ever renamed here.
 *
 * A real tmux, isolated on its own socket: what a rename does to a name is the
 * whole point and a table cannot say it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settled } from "./paneSettled.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const SOCKET = `agx-cardtab-${process.pid}`;
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const REAL_STATE = process.env.AGENTGLASS_STATE_DIR;
/* `env -u TMUX`: a suite started from inside a tmux client is still its own
   server, and the variable is what makes tmux talk about a window it does not
   own. Put back in afterAll, because `bun test` shares one process. */
const REAL_TMUX = process.env.TMUX;
delete process.env.TMUX;
const STATE = mkdtempSync(join(tmpdir(), `agx-cardtab-${process.pid}-state-`));
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;
process.env.AGENTGLASS_STATE_DIR = STATE;

const { engineWindowOutcome, liveWindows, tmux, tmuxCapability } = await import("../src/tmuxpane.ts");

let dir = "";
const have = tmuxCapability().available;

/** The window's own three answers: what it is called, whether tmux may rename it, and the name it was made as. */
const shown = async (windowId: string): Promise<string> =>
  (await tmux(["display-message", "-p", "-t", windowId, "#{window_name}\t#{automatic-rename}\t#{@agx-given}"])).stdout.trim();

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agx-cardtab-")); });
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

describe("the tab of a card with a Jira key", () => {
  it.skipIf(!have)("is called <project>-<JIRA-KEY>, and tmux is not allowed to change it", async () => {
    const w = await engineWindowOutcome(dir, "orbit-ORBIT-1042", ["sh", "-c", "sleep 30"], dir);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    /* Read until the window answers with both facts: a window made a moment ago
       is still being set up by tmux's child. */
    const got = await settled(() => shown(w.windowId), (v) => v.startsWith("orbit-ORBIT-1042\t"));
    expect(got).toBe("orbit-ORBIT-1042\t0\torbit-ORBIT-1042");
  });
});

describe("a tab a person renamed", () => {
  it.skipIf(!have)("keeps its name when the card is opened again, and gains no second tab", async () => {
    const w = await engineWindowOutcome(dir, "orbit-ORBIT-2001", ["sh", "-c", "sleep 30"], dir);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    /* The lookup is by name AND by folder, so the pane has to have reached its
       directory before the second open is asked: that is the state a card is
       opened again from. */
    await settled(async () => (await liveWindows()).find((x) => x.windowId === w.windowId)?.path, (p) => p === dir);
    expect((await tmux(["rename-window", "-t", w.windowId, "my notes"])).ok).toBe(true);

    const again = await engineWindowOutcome(dir, "orbit-ORBIT-2001", ["sh", "-c", "sleep 30"], dir, undefined, undefined, false, true);
    expect(again.ok).toBe(true);
    /* The premise: the card's own name is gone from the strip, and the tab it
       was is the one that came back. */
    expect(again.ok && again.reused).toBe(true);
    expect(again.ok && again.windowId).toBe(w.windowId);
    expect((await shown(w.windowId)).startsWith("my notes\t")).toBe(true);
    const names = (await liveWindows()).map((x) => x.name);
    expect(names).not.toContain("orbit-ORBIT-2001");
    expect(names).toContain("my notes");
  });
});

describe("two cards whose names look alike", () => {
  it.skipIf(!have)("are not handed each other's tab", async () => {
    /* A ClickUp space and the connected Jira site can both spell a card
       `DEV-1042`, and the tab name is only the part a person reads. The card's
       own id is what says whose work is in the window. */
    const first = await engineWindowOutcome(dir, "orbit-DEV-1042", ["sh", "-c", "sleep 30"], dir, undefined, undefined, true, true, false, "clickup-dev-1042");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await engineWindowOutcome(dir, "orbit-DEV-1042", ["sh", "-c", "sleep 30"], dir, undefined, undefined, true, true, false, "jira-dev-1042");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reused).toBeUndefined();
    expect(second.windowId).not.toBe(first.windowId);
    const again = await engineWindowOutcome(dir, "orbit-DEV-1042", ["sh", "-c", "sleep 30"], dir, undefined, undefined, true, true, false, "jira-dev-1042");
    expect(again.ok && again.reused).toBe(true);
    expect(again.ok && again.windowId).toBe(second.windowId);
  });
});
