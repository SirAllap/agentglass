/*
 * The window a run opened dies when its turn ends — and nothing else does.
 *
 * The negative is the test that matters, so it is written first. On this
 * machine right now there are 24 `claude` processes and eight of them are the
 * user's own work, in another repository, 43 to 51 hours old, continued
 * tomorrow morning. A cleanup that decides from what a window LOOKS like — the
 * name a run gives it, a `claude` in a worktree shaped like ours, an age — will
 * eventually be right about a leak and wrong about one of those, and being
 * wrong once costs more than the whole feature saves.
 *
 * So the rule under test is: the only thing that can be closed is a window this
 * server stamped when it opened it, proved by reading the stamp back off that
 * window id. tmux is injected, because a test that reached a real one would be
 * killing whatever the developer had open — which is the same mistake, made by
 * the suite instead of the sweeper.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  takeLease, endLease, leaseHeld, reapLeases, leases, LEASE_OPTION, __forgetLeases, __resetLeases,
} from "../src/panelease.ts";

/** A tmux server, as a parameter: windows that carry options, and a record of
 *  what was killed. `stamp` fails for a window that is not there, the way the
 *  real `set-option -t` does. */
function fakeTmux(windows: Record<string, Record<string, string>> = {}) {
  const killed: string[] = [];
  const live: Record<string, Record<string, string>> = { ...windows };
  return {
    killed,
    live,
    io: {
      stamp: async (windowId: string, token: string) => {
        if (!live[windowId]) return false;
        live[windowId][LEASE_OPTION] = token;
        return true;
      },
      readStamp: async (windowId: string) => live[windowId]?.[LEASE_OPTION] ?? "",
      kill: async (windowId: string) => { killed.push(windowId); delete live[windowId]; },
    },
  };
}

beforeEach(() => { __resetLeases(); });
afterEach(() => { __resetLeases(); });

describe("a window nobody leased", () => {
  test("one that resembles ours is not touched", async () => {
    // Same socket, same name shape, same command — everything a heuristic would
    // look at. What it does not have is a lease, which is the only thing asked.
    const t = fakeTmux({ "@4": { "@name": "understudy: rename the banner copy" } });
    expect(await endLease("@4", t.io)).toBe(false);
    expect(t.killed).toEqual([]);
  });

  test("a leased id whose stamp has changed is not touched", async () => {
    // A tmux server that has been restarted hands out `@0` again, and the first
    // window on the engine is the user's terminal view. The record survives that
    // restart; the stamp does not, which is what makes the record inert.
    const t = fakeTmux({ "@0": {} });
    await takeLease("@0", "a run", t.io);
    t.live["@0"] = { [LEASE_OPTION]: "somebody-elses" };
    expect(await endLease("@0", t.io)).toBe(false);
    expect(t.killed).toEqual([]);
    expect(leases()).toEqual([]); // and the record is dropped, not carried
  });

  test("a window that could not be stamped is never ours", async () => {
    const t = fakeTmux(); // no such window: `set-option` fails
    expect(await takeLease("@9", "a run", t.io)).toBeNull();
    expect(await endLease("@9", t.io)).toBe(false);
    expect(t.killed).toEqual([]);
  });
});

describe("a window we opened", () => {
  test("is closed at the end of its turn, and only it", async () => {
    const t = fakeTmux({ "@1": {}, "@2": {}, "@3": {} });
    await takeLease("@2", "a run", t.io);
    expect(await endLease("@2", t.io)).toBe(true);
    expect(t.killed).toEqual(["@2"]);
  });

  test("closing twice kills once", async () => {
    // The turn ends, and then the run's failure path ends it again. Both exits
    // call this, deliberately — it is cheaper than proving no path calls it
    // twice, and there is nothing left to kill the second time.
    const t = fakeTmux({ "@1": {} });
    await takeLease("@1", "a run", t.io);
    expect(await endLease("@1", t.io)).toBe(true);
    expect(await endLease("@1", t.io)).toBe(false);
    expect(t.killed).toEqual(["@1"]);
  });
});

describe("the server restarts mid-run", () => {
  test("the sweep at startup closes what the dead process held", async () => {
    const t = fakeTmux({ "@5": {}, "@6": {} });
    await takeLease("@5", "a run", t.io);
    __forgetLeases(); // the process that knew about @5 is gone; the file is not
    expect(await reapLeases(t.io)).toEqual(["@5"]);
    expect(t.killed).toEqual(["@5"]);
    expect(leases()).toEqual([]);
  });

  test("and closes nothing when the tmux server went with it", async () => {
    const t = fakeTmux({ "@5": {} });
    await takeLease("@5", "a run", t.io);
    __forgetLeases();
    // A fresh engine, ids from zero again, none of them stamped by us.
    t.live["@5"] = {};
    expect(await reapLeases(t.io)).toEqual([]);
    expect(t.killed).toEqual([]);
  });
});

/*
 * Liveness, which is the same question as ownership asked while waiting.
 *
 * The run loop had no way to tell a working agent from a dead one: it polled
 * for an exit-code file and, when the agent died without writing one, waited
 * out its full forty-five minute budget. Measured on this machine — a run sat
 * "running" for thirty-five minutes with no process anywhere and not one file
 * touched in its worktree.
 */
describe("leaseHeld says whether the window we opened is still there", () => {
  test("true while the window carries our stamp", async () => {
    const t = fakeTmux({ "@9": {} });
    expect(await takeLease("@9", "a run", t.io)).not.toBeNull();
    expect(await leaseHeld("@9", t.io)).toBe(true);
  });

  test("false once the window is gone", async () => {
    const t = fakeTmux({ "@9": {} });
    await takeLease("@9", "a run", t.io);
    delete t.live["@9"];
    expect(await leaseHeld("@9", t.io)).toBe(false);
  });

  test("false when the id was reused and now carries somebody else's stamp", async () => {
    const t = fakeTmux({ "@9": {} });
    await takeLease("@9", "a run", t.io);
    // A window id is per tmux server and gets reused. The stamp is what stops
    // the loop from waiting on — or later killing — the window that took it.
    t.live["@9"] = { [LEASE_OPTION]: "somebody-elses-token" };
    expect(await leaseHeld("@9", t.io)).toBe(false);
  });

  test("false for a window we never opened", async () => {
    const t = fakeTmux({ "@9": { [LEASE_OPTION]: "not ours" } });
    expect(await leaseHeld("@9", t.io)).toBe(false);
  });

  test("it does not kill anything — that is endLease's job", async () => {
    const t = fakeTmux({ "@9": {} });
    await takeLease("@9", "a run", t.io);
    await leaseHeld("@9", t.io);
    delete t.live["@9"];
    await leaseHeld("@9", t.io);
    expect(t.killed).toEqual([]);
    // And the record survives a false answer, so `endLease` still runs its own
    // check in the `finally` rather than finding nothing to check.
    expect(leases().map((l) => l.windowId)).toEqual(["@9"]);
  });
});
