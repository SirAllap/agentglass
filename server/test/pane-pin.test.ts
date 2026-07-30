/*
 * Saying "not this one" to the sweeper, and being able to see what is running.
 *
 * Idle eviction is right for the common case and wrong for the chat you are
 * actually living in: step away for lunch and the session you care about is
 * precisely the one reclaimed, so the turn you come back to is the slow one —
 * the exact cost the pane engine exists to remove.
 *
 * `listPanes` and `killPane` shell out to tmux, which is not running here, so
 * they are injected. What is under test is the *decision* — which panes the
 * sweeper takes and which it leaves — and that is the part with a several
 * hundred megabyte process on the other end of it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  evictIdlePanes, touchPane, forgetPane, pinPane, isPinned, panes, classifyPanes, __resetPaneState,
} from "../src/tmuxpane.ts";

/**
 * tmux, as a parameter.
 *
 * A module namespace is frozen, so there is nothing to monkey-patch here — and
 * that is the better answer anyway: `evictIdlePanes` and `panes` take their
 * listing and killing the same way `reachableAddresses` takes its interfaces
 * and `firewallHint` takes its `which`. A test that reached a real tmux would
 * be reading, and reaping, the developer's own sessions.
 */
function fakeTmux(names: string[]) {
  const killed: string[] = [];
  const live = new Set(names);
  return {
    killed,
    live,
    io: {
      list: async () => [...live],
      kill: async (n: string) => { killed.push(n); live.delete(n); },
    },
  };
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.AGENTGLASS_TMUX_IDLE_MINUTES = "30";
  __resetPaneState();
});

afterEach(() => { __resetPaneState(); });

const HOUR = 3_600_000;

/**
 * Pane names are session ids, and the shape is pinned to what a uuid is —
 * tmux treats `:` and `.` as window/pane separators, so a crafted name could
 * resolve onto a target nobody meant. Short readable names are refused, which
 * is correct and is why these are not "chat-a".
 */
const A = "6b191fd3-f71e-5010-863d-d32334eaf400";
const B = "9c2a41ee-0d38-4a17-91bb-6f0e2b7c1d55";
const STRANGER = "0e77b2c4-3a91-4d60-8f2e-1c5a9b3d7e88";

describe("pinning", () => {
  test("a pinned pane is not reclaimed, however long it sits", async () => {
    const t0 = 2_000_000;
    const t = fakeTmux([A, B]);
    touchPane(A, t0);
    touchPane(B, t0);
    pinPane(A, true);
    // Both are an hour idle, which is twice the window.
    expect(await evictIdlePanes(t0 + HOUR, t.io)).toEqual([B]);
    expect(t.killed).toEqual([B]);
  });

  test("unpinning puts it straight back under the ordinary rule", async () => {
    // Judged on when it was last *used*, not on when the pin came off — the pin
    // suspends the sweeper's interest in a pane, it does not restart its clock.
    const t0 = 1_000_000;
    const t = fakeTmux([A]);
    touchPane(A, t0);
    pinPane(A, true);
    expect(await evictIdlePanes(t0 + HOUR, t.io)).toEqual([]);
    pinPane(A, false);
    expect(await evictIdlePanes(t0 + HOUR, t.io)).toEqual([A]);
  });

  test("closing a chat releases its pane, pinned or not", async () => {
    // Pinning is about idleness. Closing is an explicit "done", and a pin that
    // survived it would be a memory leak with a switch in front of it.
    pinPane(A, true);
    expect(isPinned(A)).toBe(true);
    forgetPane(A);
    expect(isPinned(A)).toBe(false);
  });

  test("a name that is not a pane name is refused", () => {
    // The name goes to `tmux kill-session -t`, so the same validation the rest
    // of this module applies to it applies here.
    expect(pinPane("../../etc/passwd", true)).toBe(false);
    expect(pinPane("a; rm -rf /", true)).toBe(false);
    expect(pinPane("sess:0.1", true)).toBe(false); // tmux's window/pane separators
    expect(pinPane("short", true)).toBe(false);    // a uuid is longer than this
    expect(isPinned("a; rm -rf /")).toBe(false);
    expect(pinPane(A, true)).toBe(true);
  });

  test("pinning does not resurrect the record of a pane nobody has used", async () => {
    // A pane this process has never served is left alone for one full interval
    // whether or not it is pinned — the sweeper's existing rule, unchanged.
    const t = fakeTmux([STRANGER]);
    pinPane(STRANGER, true);
    expect(await evictIdlePanes(3_000_000 + HOUR, t.io)).toEqual([]);
    expect(t.killed).toEqual([]);
  });
});

describe("what the sweeper still does", () => {
  test("reclaims an unpinned pane past the window", async () => {
    const t0 = 4_000_000;
    const t = fakeTmux([A]);
    touchPane(A, t0);
    expect(await evictIdlePanes(t0 + HOUR, t.io)).toEqual([A]);
  });

  test("leaves one inside the window alone", async () => {
    const t0 = 5_000_000;
    const t = fakeTmux([A]);
    touchPane(A, t0);
    expect(await evictIdlePanes(t0, t.io)).toEqual([]);
  });

  test("leaves a pane it has never seen, and gives it a full interval", async () => {
    // Unchanged and load-bearing: after a restart every genuinely live chat
    // looks exactly like an orphan, and killing an agent mid-work to save
    // memory is a much worse failure than holding the memory.
    const t0 = 9_000_000;
    const t = fakeTmux([STRANGER]);
    expect(await evictIdlePanes(t0, t.io)).toEqual([]);
    expect(await evictIdlePanes(t0 + HOUR, t.io)).toEqual([STRANGER]);
  });

  test("does nothing at all when eviction is switched off", async () => {
    process.env.AGENTGLASS_TMUX_IDLE_MINUTES = "0";
    const t0 = 6_000_000;
    const t = fakeTmux([A]);
    touchPane(A, t0);
    expect(await evictIdlePanes(t0 + 10 * HOUR, t.io)).toEqual([]);
    expect(t.killed).toEqual([]);
  });
});

describe("seeing what is running", () => {
  test("reports every pane, with what is known about each", async () => {
    const t = fakeTmux([A, STRANGER]);
    touchPane(A, 7_000_000);
    pinPane(A, true);
    const rows = await panes(t.io.list);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.name === A)!;
    expect(a.pinned).toBe(true);
    expect(a.lastUsedAt).toBe(7_000_000);
    // Null rather than zero: "this server has never run a turn in it" is the
    // shape of a leftover from a previous run, and 0 would render as 1970.
    const s = rows.find((r) => r.name === STRANGER)!;
    expect(s.lastUsedAt).toBeNull();
    expect(s.pinned).toBe(false);
  });

  test("is empty when nothing is running, rather than throwing", async () => {
    const t = fakeTmux([]);
    expect(await panes(t.io.list)).toEqual([]);
  });
});

/**
 * Which panes belong to nothing.
 *
 * Pure, and tested here rather than through the route, because a machine with
 * no tmux has no panes to classify — which is every test machine, and is how
 * this judgement went untested when it was three lines inside the handler.
 */
describe("deciding what is an orphan", () => {
  const rows = [A, B, STRANGER].map((name) => ({ name, lastUsedAt: null, pinned: false }));

  test("a pane no open chat and no running turn points at", () => {
    const out = classifyPanes(rows, [A], [B]);
    expect(out.find((p) => p.name === STRANGER)!.orphan).toBe(true);
    expect(out.find((p) => p.name === A)!.orphan).toBe(false);
    expect(out.find((p) => p.name === B)!.orphan).toBe(false);
  });

  test("a pane mid-turn is never an orphan, whatever is on screen", () => {
    // The proof that something is using it, and the one row that must not be
    // offered a one-click end. A window with no chats open at all — the app
    // reopened in a second tab — must not mark a working agent abandoned.
    const out = classifyPanes(rows, [], [B]);
    expect(out.find((p) => p.name === B)!).toMatchObject({ running: true, orphan: false });
  });

  test("and a chat open in this window keeps its pane, mid-turn or not", () => {
    const out = classifyPanes(rows, [A, B, STRANGER], []);
    expect(out.every((p) => !p.orphan)).toBe(true);
    expect(out.every((p) => !p.running)).toBe(true);
  });

  test("with nothing open and nothing running, everything is an orphan", () => {
    // The state after a crash: the panes are still there and nothing in the app
    // knows about any of them. Exactly what the panel exists to show.
    expect(classifyPanes(rows, [], []).every((p) => p.orphan)).toBe(true);
  });

  test("and what it was told about each pane survives the classification", () => {
    const out = classifyPanes([{ name: A, lastUsedAt: 7_000_000, pinned: true }], [A], []);
    expect(out[0]).toMatchObject({ name: A, lastUsedAt: 7_000_000, pinned: true });
  });
});
