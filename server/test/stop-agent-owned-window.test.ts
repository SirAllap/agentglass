/*
 * agentglass never closes a window it does not own. `stopAgent` asks the
 * PANE whose window it is at the moment of the kill, and the kill names that
 * pane: never the row's stored `@N` (a pane moved by join/break-pane, or a
 * reused id, names another window), and never an empty target, which tmux
 * reads as "the current window" — a person's tab.
 */
import { describe, expect, test } from "bun:test";
import { paneOwner, stopAgent } from "../src/agentops.ts";

type Call = string[];
const asker = (answer: { ok: boolean; stdout: string; stderr: string }) => {
  const calls: Call[] = [];
  const ask = (async (args: string[]) => { calls.push(args); return args[0] === "kill-window" ? { ok: true, stdout: "", stderr: "" } : answer; }) as never;
  return { calls, ask, kills: () => calls.filter((c) => c[0] === "kill-window") };
};
const row = (o: Record<string, unknown> = {}) => ({ name: "thing-fix", kind: "claude", cwd: "/tmp", paneId: "%3", windowId: "@2", startedAt: 1, endedAt: null, ...o }) as never;

describe("stopAgent closes only its own window", () => {
  test("the kill names the verified pane, not the stored window id", async () => {
    const t = asker({ ok: true, stdout: "4242\tthing-fix\n", stderr: "" });
    const r = await stopAgent(row(), 1, true, { ask: t.ask });
    expect(t.kills()).toEqual([["kill-window", "-t", "%3"]]);
    expect(r.killed).toBe(true);
  });

  test("a kept tab of an ended agent is closed through its pane too", async () => {
    const t = asker({ ok: true, stdout: "4242\tthing-fix\n", stderr: "" });
    await stopAgent(row({ endedAt: 5 }), 6, true, { ask: t.ask, endsWindow: false });
    expect(t.kills()).toEqual([["kill-window", "-t", "%3"]]);
  });

  test("an empty pane (a re-linked seat) is never a target", async () => {
    // tmux would answer "own" for the current window: the id is refused before it is asked.
    const t = asker({ ok: true, stdout: "4242\tthing-fix\n", stderr: "" });
    expect(await paneOwner("", "thing-fix", t.ask)).toEqual({ own: false, why: "foreign" });
    expect(await paneOwner("@2", "thing-fix", t.ask)).toEqual({ own: false, why: "foreign" });
    const r = await stopAgent(row({ paneId: "", windowId: "" }), 1, true, { ask: t.ask });
    expect(t.calls).toEqual([]);
    expect(r.killed).toBe(false);
  });

  test("a person's tab the pane now resolves to is left open", async () => {
    const t = asker({ ok: true, stdout: "4242\t\n", stderr: "" });
    const r = await stopAgent(row(), 1, true, { ask: t.ask });
    // The pane was asked, at the kill: the answer is what left it open.
    expect(t.calls.map((c) => c[0])).toEqual(["display-message"]);
    expect(t.calls[0]).toContain("%3");
    expect(t.kills()).toEqual([]);
    expect(r.killed).toBe(false);
  });

  test("tmux that did not answer ends nothing", async () => {
    const t = asker({ ok: false, stdout: "", stderr: "tmux timed out" });
    const r = await stopAgent(row(), 1, true, { ask: t.ask });
    expect(t.kills()).toEqual([]);
    expect(r).toEqual({ ok: false, killed: false, unknown: true });
  });
});
