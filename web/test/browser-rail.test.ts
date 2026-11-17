import { describe, expect, test } from "bun:test";
import { agentDrives, nextDriveCheck, publishBrowserRail, browserRailFacts, railTipFor, subscribeBrowserRail } from "../src/lib/browserRail.ts";
import { IDLE_RELEASE_MS, type Activity } from "../src/lib/browserAgentActivity.ts";

const act = (o: Partial<Activity[string]> = {}): Activity[string] => ({ agent: "scout", working: 0, paused: false, log: [], ...o });

describe("an agent drives the browser", () => {
  test("mid-ask is driving", () => {
    expect(agentDrives({ t1: act({ working: 1 }) }, 1000, ["t1"])).toBe(true);
  });
  test("a recent ask, not finished, still holds the tab", () => {
    expect(agentDrives({ t1: act({ lastAt: 1000 }) }, 5000, ["t1"])).toBe(true);
  });
  test("done, paused, idle for too long or nobody is not driving", () => {
    expect(agentDrives({ t1: act({ working: 1, done: true }) }, 1, ["t1"])).toBe(false);
    expect(agentDrives({ t1: act({ working: 1, paused: true }) }, 1, ["t1"])).toBe(false);
    expect(agentDrives({ t1: act({ lastAt: 1000 }) }, 1000 + IDLE_RELEASE_MS + 1, ["t1"])).toBe(false);
    expect(agentDrives({}, 1, ["t1"])).toBe(false);
  });
  test("a closed tab is never driven, so no tab open means nobody drives", () => {
    expect(agentDrives({ gone: act({ working: 1 }) }, 1000, ["t1"])).toBe(false);
    expect(agentDrives({ gone: act({ lastAt: 1000 }) }, 1000, [])).toBe(false);
    expect(agentDrives({ t1: act({ working: 1 }) }, 1000, [])).toBe(false);
  });
  test("the idle window ending turns driving off with no event", () => {
    const acts = { t1: act({ lastAt: 1000 }) };
    const wait = nextDriveCheck(acts, 2000, ["t1"]);
    expect(wait).toBe(1000 + IDLE_RELEASE_MS - 2000 + 1);
    expect(agentDrives(acts, 2000, ["t1"])).toBe(true);
    expect(agentDrives(acts, 2000 + wait!, ["t1"])).toBe(false);
  });
  test("the next re-check is the earliest window among open tabs, or none", () => {
    const acts = { a: act({ lastAt: 1000 }), b: act({ lastAt: 500 }), gone: act({ lastAt: 100 }) };
    expect(nextDriveCheck(acts, 1000, ["a", "b"])).toBe(500 + IDLE_RELEASE_MS - 1000 + 1);
    expect(nextDriveCheck({ t1: act({ working: 1, lastAt: 1000 }) }, 1000, ["t1"])).toBeNull();
    expect(nextDriveCheck({ t1: act({ lastAt: 1000, paused: true }) }, 1000, ["t1"])).toBeNull();
    expect(nextDriveCheck(acts, 1000 + IDLE_RELEASE_MS + 1, ["a", "b"])).toBeNull();
    expect(nextDriveCheck(acts, 1000, [])).toBeNull();
  });
});

describe("the rail's words and snapshot", () => {
  test("tooltip", () => {
    expect(railTipFor({ tabs: 0, driven: false })).toBeNull();
    expect(railTipFor({ tabs: 1, driven: false })).toBe("1 tab");
    expect(railTipFor({ tabs: 3, driven: true })).toBe("3 tabs · an agent is driving");
  });
  test("subscribers hear a change once and an equal publish not at all", () => {
    let n = 0;
    const off = subscribeBrowserRail(() => { n++; });
    publishBrowserRail({ tabs: 2, driven: true });
    publishBrowserRail({ tabs: 2, driven: true });
    expect(n).toBe(1);
    expect(browserRailFacts()).toEqual({ tabs: 2, driven: true });
    off();
  });
});
