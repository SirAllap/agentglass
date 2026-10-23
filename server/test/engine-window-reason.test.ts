/*
 * When tmux refuses to open a window, the answer says why.
 *
 * `engineWindowRunning` returned null for four different reasons — a refused
 * command, an id it could not parse, a session name tmux cannot take, no tmux
 * at all — and the button that asked showed one sentence for all of them:
 * "the engine would not open a window". Nobody could tell a briefing too big
 * for tmux from a missing binary without reproducing it, which is how the
 * first measurement of this took an afternoon.
 *
 * Against a real tmux on a socket of its own, for the same reason as
 * engine-window-opens.test.ts: what matters is the text tmux really prints.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const SOCKET = `agx-enginewhy-${process.pid}`;
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;

const { engineWindowOutcome, engineWindowRunning, tmux, tmuxCapability } = await import("../src/tmuxpane.ts");

let dir = "";
const have = tmuxCapability().available;
const errors: string[] = [];
const realError = console.error;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-enginewhy-"));
  console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
});
afterAll(async () => {
  console.error = realError;
  if (have) await tmux(["kill-server"]);
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (REAL_SOCKET === undefined) delete process.env.AGENTGLASS_TMUX_SOCKET;
  else process.env.AGENTGLASS_TMUX_SOCKET = REAL_SOCKET;
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
});

describe("why a window did not open", () => {
  it("names tmux's own words and the size of the command", async () => {
    if (!have) return;
    errors.length = 0;
    // 60 KB in one argument is what a briefing for a long file list comes to.
    const w = await engineWindowOutcome(dir, "conflict-1042", ["sleep", "30", "x".repeat(60_000)]);
    expect(w.ok).toBe(false);
    if (w.ok) return;
    expect(w.reason).toContain("tmux refused the command");
    expect(w.reason).toContain("command too long");
    expect(w.reason).toMatch(/\(\d+ KB\)/);
    // Logged once, with the same words, so the log and the button agree.
    expect(errors.filter((e) => e.includes("command too long")).length).toBe(1);
  });

  it("still returns null through the old entry point", async () => {
    if (!have) return;
    const w = await engineWindowRunning(dir, "conflict-1042", ["sleep", "30", "x".repeat(60_000)]);
    expect(w).toBeNull();
  });

  it("says ok with the ids when it worked", async () => {
    if (!have) return;
    const w = await engineWindowOutcome(dir, "conflict-1043", ["sleep", "30"]);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.paneId).toMatch(/^%\d+$/);
    expect(w.windowId).toMatch(/^@\d+$/);
  });
});

describe("a session with windows named after it", () => {
  /* The real failure behind "the engine would not open a window": a bare
     `-t orbit` is read as a WINDOW first, and tmux matches window names by
     prefix, so a session `orbit` holding a window `orbit-ORBIT-1042` was asked
     to put the new window at that window's index — "create window failed:
     index 1 in use". Every press failed for as long as such a window lived. */
  it("opens beside them, in the session that was asked for", async () => {
    if (!have) return;
    await tmux(["new-session", "-d", "-s", "orbit", "-n", "Orchestrator-orbit", "sleep", "300"]);
    await tmux(["new-window", "-d", "-t", "orbit:", "-n", "orbit-ORBIT-1042", "sleep", "300"]);
    for (const select of [true, false]) {
      const w = await engineWindowOutcome(dir, "conflict-1042", ["sleep", "30"], dir, undefined, "orbit", select);
      expect(w, JSON.stringify(w)).toMatchObject({ ok: true });
    }
    const ls = await tmux(["list-windows", "-t", "=orbit:", "-F", "#{window_name}"]);
    expect(ls.stdout.trim().split("\n").filter((n) => n === "conflict-1042").length).toBe(2);
  });

  it("splits the pane on screen, not a window that happens to share a prefix", async () => {
    if (!have) return;
    const { engineSplitRunning, engineSessionName } = await import("../src/tmuxpane.ts");
    // A checkout of its own, so the session is one this test makes.
    const root = mkdtempSync(join(tmpdir(), "agx-enginesplit-"));
    const session = engineSessionName(root);
    await tmux(["new-session", "-d", "-s", session, "-n", `${session}-card`, "sleep", "300"]);
    await tmux(["new-window", "-t", `=${session}:`, "-n", "work", "sleep", "300"]);
    const r = await engineSplitRunning(root, root, ["sleep", "30"]);
    expect(r).not.toBeNull();
    const ls = await tmux(["list-panes", "-s", "-t", `=${session}:`, "-F", "#{window_name}"]);
    expect(ls.stdout.trim().split("\n").sort()).toEqual([`${session}-card`, "work", "work"]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the issue handler tells the person the reason", () => {
  it("answers with the outcome's reason, not a fixed sentence", async () => {
    const terminal = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
    const at = terminal.indexOf('if (msg.cmd === "issue")');
    const end = terminal.indexOf("Resume a session the picker found", at);
    const block = terminal.slice(at, end);
    expect(block).toContain("engineWindowOutcome(");
    expect(block).not.toContain('"the engine would not open a window"');
  });
});
