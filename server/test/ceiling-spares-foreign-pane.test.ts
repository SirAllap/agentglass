/*
 * The turn-limit stop ends in SIGKILL, so it may only reach a window launched
 * for that worker. A person's tab or an orchestrator's seat that a stale pane
 * id resolves to carries no `@agx_owner`, or another one, and is left alone.
 */
import { describe, expect, test } from "bun:test";
import { ownsPane } from "../src/agents/ceilings.ts";

describe("ownsPane", () => {
  test("the worker's own window is stopped", () => {
    expect(ownsPane("4242\tthing-fix\n", "thing-fix")).toEqual({ pid: 4242 });
  });
  test("a person's tab with no owner is never signalled", () => {
    expect(ownsPane("4242\t\n", "thing-fix")).toBeNull();
  });
  test("an orchestrator seat or another worker is never signalled", () => {
    expect(ownsPane("4242\tOrchestrator-orbit\n", "thing-fix")).toBeNull();
    expect(ownsPane("4242\tthing-fix2\n", "thing-fix")).toBeNull();
  });
  test("an answer with no usable pid is nothing", () => {
    expect(ownsPane("\tthing-fix", "thing-fix")).toBeNull();
    expect(ownsPane("1\tthing-fix", "thing-fix")).toBeNull();
  });
});

describe("killTree", () => {
  const row = { name: "thing-fix", paneId: "%3", windowId: "@2", endedAt: null, startedAt: 1 } as never;
  const ok = (stdout: string) => (async () => ({ ok: true, stdout, stderr: "" })) as never;
  const spy = () => {
    const kills: boolean[] = [];
    const stop = (async (_a: unknown, _n: number, kill: boolean) => { kills.push(kill); return { ok: true, killed: kill }; }) as never;
    return { kills, stop };
  };

  test("the worker's own window is stopped and closed", async () => {
    const { killTree } = await import("../src/agents/ceilings.ts");
    const s = spy();
    // A pid that is not running: the signals go nowhere, the close is what is checked.
    expect(await killTree(row, { ask: ok("999999\tthing-fix\n"), stop: s.stop })).toEqual([999999]);
    expect(s.kills).toEqual([true]);
  });

  test("a person's tab is never closed: only the bookkeeping runs", async () => {
    const { killTree } = await import("../src/agents/ceilings.ts");
    const s = spy();
    expect(await killTree(row, { ask: ok("4242\t\n"), stop: s.stop })).toEqual([]);
    expect(s.kills).toEqual([false]);
  });

  test("a pane that is gone gets the bookkeeping only", async () => {
    const { killTree } = await import("../src/agents/ceilings.ts");
    const s = spy();
    const gone = (async () => ({ ok: false, stdout: "", stderr: "can't find pane: %3" })) as never;
    expect(await killTree(row, { ask: gone, stop: s.stop })).toEqual([]);
    expect(s.kills).toEqual([false]);
  });

  test("tmux that did not answer is unknown: the row is not ended, and it asks again", async () => {
    const { killTree } = await import("../src/agents/ceilings.ts");
    const timeout = { ok: false, stdout: "", stderr: "tmux timed out" };
    let s = spy();
    expect(await killTree(row, { ask: (async () => timeout) as never, stop: s.stop, tries: 1 })).toBeNull();
    expect(s.kills).toEqual([]);
    // The next ask answers: the worker is stopped then.
    s = spy();
    const answers = [timeout, { ok: true, stdout: "999999\tthing-fix\n", stderr: "" }];
    const ask = (async () => answers.shift() ?? { ok: true, stdout: "", stderr: "" }) as never;
    expect(await killTree(row, { ask, stop: s.stop, tries: 2, retryMs: 1, row: () => row })).toEqual([999999]);
    expect(s.kills).toEqual([true]);
  });
});
