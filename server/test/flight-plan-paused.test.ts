/*
 * A launched plan whose builder tab is gone is paused: it must not hold one of
 * the flightPlan.maxFlying slots, or a plan waiting at Go queues behind a card
 * that does nothing. The tab check is a pure function; the launch count is
 * asserted against source because the route needs a live tmux.
 */
import { describe, expect, test } from "bun:test";
import { builderLive, builderOf, holdsSlot, noteGone, stateSinceOf, trackGone, type WindowTrees } from "../src/flightPlan.ts";

const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

describe("a builder is live only while its tab has a live pane", () => {
  test("a gone window is paused", () => {
    expect(builderLive(null)).toBe(false);
    expect(builderLive([])).toBe(false);
  });
  test("only dead panes is paused", () => {
    expect(builderLive([{ dead: true }])).toBe(false);
  });
  test("one live pane is working", () => {
    expect(builderLive([{ dead: true }, {}])).toBe(true);
  });
});

describe("the launch queue counts builders with a tab", () => {
  test("launchFlightPlan counts flyingWithBuilder, not every launched plan", () => {
    const start = index.indexOf("async function launchFlightPlan(");
    expect(start).toBeGreaterThan(-1);
    const body = index.slice(start, index.indexOf("\n}\n", start));
    expect(body).toContain("flyingWithBuilder(plan.root, base)");
    expect(body).not.toContain("FlightPlan.flying(plan.root, base)");
  });
});

/* A stubbed tmux: the windows of each session, as `allWindowTrees` lists them. */
const tmuxWith = (): WindowTrees => new Map([["orbit", [{ id: "@3", panes: [{}] }, { id: "@4", panes: [{ dead: true }] }]]]);

describe("what the list says of a builder's tab", () => {
  test("a live pane is live; a closed window or only dead panes is gone", () => {
    expect(builderOf({ session: "orbit", window: "@3" }, tmuxWith())).toBe("live");
    expect(builderOf({ session: "orbit", window: "@9" }, tmuxWith())).toBe("gone");
    expect(builderOf({ session: "orbit", window: "@4" }, tmuxWith())).toBe("gone");
    expect(builderOf({ session: "elsewhere", window: "@3" }, tmuxWith())).toBe("gone");
  });
  test("no window on record is none, whatever tmux says", () => {
    expect(builderOf(null, tmuxWith())).toBe("none");
    expect(builderOf({ session: "orbit" }, tmuxWith())).toBe("none");
    expect(builderOf({}, null)).toBe("none");
  });
  test("tmux that did not answer is unknown, never gone", () => {
    expect(builderOf({ session: "orbit", window: "@3" }, null)).toBe("unknown");
  });
  test("a launch that recorded no session is found in any session", () => {
    expect(builderOf({ window: "@3" }, tmuxWith())).toBe("live");
    expect(builderOf({ window: "@9" }, tmuxWith())).toBe("gone");
  });
  test("only a tab known to be gone gives its slot back", () => {
    expect([holdsSlot("live"), holdsSlot("none"), holdsSlot("unknown"), holdsSlot("gone")]).toEqual([true, true, true, false]);
  });
});

describe("goneAt: stamped by the first read that sees the tab gone, once, cleared when it is live", () => {
  test("set once, kept, cleared on live, restamped on the next closing", () => {
    const seen = new Map<string, number>();
    expect(noteGone(seen, "p1", "live", 100)).toBeNull();
    expect(noteGone(seen, "p1", "gone", 200)).toBe(200);
    expect(noteGone(seen, "p1", "gone", 300)).toBe(200);
    expect(noteGone(seen, "p1", "live", 400)).toBeNull();
    expect(noteGone(seen, "p1", "gone", 500)).toBe(500);
  });
  test("an unreadable tmux writes nothing and clears nothing", () => {
    const seen = new Map<string, number>();
    expect(noteGone(seen, "p1", "unknown", 100)).toBeNull();
    expect(seen.size).toBe(0);
    noteGone(seen, "p1", "gone", 200);
    expect(noteGone(seen, "p1", "unknown", 300)).toBe(200);
  });
});

describe("goneAt is forgotten with the plan's flight, never by absence", () => {
  const plan = (o: Record<string, unknown> = {}) => ({ id: "p1", state: "launched" as const, landedAt: null, ...o });
  test("a landed or no longer launched plan drops its entry", () => {
    for (const o of [{ landedAt: 5 }, { state: "no-go" as const }, { state: "go" as const }]) {
      const seen = new Map([["p1", 100]]);
      expect(trackGone(seen, plan(o), "gone", 200)).toBeNull();
      expect(seen.has("p1")).toBe(false);
    }
  });
  test("a launched plan keeps and stamps as before, and a plan missing from a partial list keeps its entry", () => {
    const seen = new Map([["p1", 100], ["other", 50]]);
    expect(trackGone(seen, plan(), "gone", 200)).toBe(100);
    expect(seen.get("other")).toBe(50);
  });
});

describe("stateSince says when the plan entered the state the person reads", () => {
  const p = (o: Record<string, unknown> = {}) => ({ state: "launched", launched: { at: 10 }, landedAt: null, updatedAt: 90, decision: { at: 5 }, question: null, stopReason: null, ...o }) as Parameters<typeof stateSinceOf>[0];
  test("landed: the landing time, whatever the tab or the report says", () => {
    expect(stateSinceOf(p({ landedAt: 70 }), 60)).toBe(70);
  });
  test("a launched plan waiting on a person since its last update, not since launch", () => {
    expect(stateSinceOf(p({ question: { text: "x" } }), null)).toBe(90);
    expect(stateSinceOf(p({ stopReason: "sensitive-diff" }), 60)).toBe(90);
  });
  test("a parked plan since its tab closed; building and quiet since launch; Go since the Go", () => {
    expect(stateSinceOf(p(), 60)).toBe(60);
    expect(stateSinceOf(p(), null)).toBe(10);
    expect(stateSinceOf(p({ state: "go", launched: null }), null)).toBe(5);
    expect(stateSinceOf(p({ state: "ready", launched: null }), null)).toBe(90);
  });
});

describe("one predicate for a builder's tab", () => {
  const fn = index.slice(index.indexOf("async function flyingWithBuilder("), index.indexOf("/** Tells each builder in the air"));
  test("the launch queue asks builderOf and holdsSlot, like the list, so a window without a session reads the same", () => {
    expect(fn).toContain("builderOf(");
    expect(fn).toContain("holdsSlot(");
    expect(fn).not.toContain("builderLive(");
  });
  test("tmux absent is unknown, which reads as Building and holds its slot", () => {
    expect(builderOf({ window: "@3" }, null)).toBe("unknown");
    expect(holdsSlot("unknown")).toBe(true);
  });
});

describe("the plans list route", () => {
  const start = index.indexOf('pathname === "/flight-plan/plans" && req.method === "GET"');
  const body = index.slice(start, index.indexOf('pathname === "/flight-plan/plans" && req.method === "POST"', start));
  test("reads tmux once for every plan, keeps the stored reason of a launched plan, and sends the three new fields", () => {
    expect(body).toContain("allWindowTrees()");
    expect(body.match(/allWindowTrees\(/g)).toHaveLength(1);
    for (const f of ["builder", "goneAt", "stateSince", "slotHolders"]) expect(body).toContain(f);
    expect(body).toContain('rest.state === "launched" ? rest.stopReason');
    expect(body).toContain("...rest");
  });
});
