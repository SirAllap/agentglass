/*
 * THE STATUS LINE IS TAKEN AND GIVEN BACK WITHOUT HOLDING THE LOOP.
 *
 * Measured on a server with 30 desk terminals and 10 agents flooding: 1.9 s of
 * the main thread in spawnSync, from `takePrompts` under `setStatusLine`, on
 * the sweep's path. Two guards: the source one fails on the old code (the sweep
 * and the socket handlers called the sync `setStatusLine`), and a real tmux
 * one pins the order a hide then a show must land in.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { setStatusLine, setStatusLineAsync, type TmuxTarget } from "../src/tmuxctl.ts";

const terminal = readFileSync(new URL("../src/terminal.ts", import.meta.url), "utf8");

describe("status line off the loop (source)", () => {
  test("only the shutdown path still calls the sync setStatusLine in terminal.ts", () => {
    const calls = terminal.split("\n").filter((l) => /\bsetStatusLine\(/.test(l) && !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"));
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("tmuxStatusHiddenOn");
  });
  test("a hide that lands after cleanup gives the bar back instead of recording it", () => {
    expect(terminal).toMatch(/function cleanup\([^)]*\) \{\n  s\.cleaned = true;/);
    const apply = terminal.slice(terminal.indexOf("function applyStatus"), terminal.indexOf("function hideStatus"));
    expect(apply).toMatch(/s\.cleaned[^]*setStatusLineAsync\(t, true\)[^]*s\.tmuxStatusHiddenOn = t/);
  });
  test("shutdown restores a hide still in flight, not only a recorded one", () => {
    const apply = terminal.slice(terminal.indexOf("function applyStatus"), terminal.indexOf("function hideStatus"));
    expect(apply.indexOf("s.tmuxStatusPending = t")).toBeLessThan(apply.indexOf("setStatusLineAsync(t, visible)"));
    expect(terminal).toContain("s.tmuxStatusHiddenOn ?? s.tmuxStatusPending");
  });
  test("the heal-budget callback re-reads the budget and skips when it was reset", () => {
    const i = terminal.indexOf("hideStatus(session, t, () => {");
    const cb = terminal.slice(i, i + 700);
    expect(cb).toContain("const now = session.tmuxBarHealBudget;");
    expect(cb).toContain("if (budget && !now) return;");
    expect(cb).not.toContain("budget.left");
  });
  test("the sweep hides through the async path", () => {
    expect(terminal).toContain("hideStatus(session, t");
    expect(terminal).toContain("setStatusLineAsync");
  });
});

const have = !!Bun.which("tmux");
const dir = mkdtempSync(join(tmpdir(), "agx-statusline-"));
const sock = join(dir, "s");
const socket = [...TMUX_ISOLATED, "-S", sock];
const tm = (...a: string[]) => Bun.spawnSync(["tmux", ...socket, ...a], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
afterAll(() => { try { tm("kill-server"); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(!have)("status line order (real tmux)", () => {
  test("a hide then a show queued together land in that order", async () => {
    tm("new-session", "-d", "-s", "a", "sleep", "300");
    const id = tm("display-message", "-p", "-t", "a", "#{session_id}");
    const t: TmuxTarget = { pid: 0, socket, session: "a", id };
    const hide = setStatusLineAsync(t, false);
    const show = setStatusLineAsync(t, true);
    expect(await hide).toBe(true);
    expect(await show).toBe(true);
    // What the SYNC pair leaves on a twin session is what the async pair must
    // leave: the show unsets the session's own values (BORROWED), so the
    // session-level status-format[0] reads empty — it is unset, not blank.
    tm("new-session", "-d", "-s", "b", "sleep", "300");
    const t2: TmuxTarget = { pid: 0, socket, session: "b", id: tm("display-message", "-p", "-t", "b", "#{session_id}") };
    setStatusLine(t2, false);
    setStatusLine(t2, true);
    const left = (x: TmuxTarget) => ["@agx-owned", "status", "status-format[0]", "status-style"]
      .map((o) => tm("show-options", "-qv", "-t", x.id, o));
    expect(left(t)).toEqual(left(t2));
    expect(tm("show-options", "-qv", "-t", id, "@agx-owned")).toBe("");
    // And the other way round ends hidden.
    const show2 = setStatusLineAsync(t, true);
    const hide2 = setStatusLineAsync(t, false);
    await Promise.all([show2, hide2]);
    expect(tm("show-options", "-qv", "-t", id, "@agx-owned")).toBe("1");
  }, 30000);
});
