/*
 * Manage sessions: what each session holds, who can be ended, who Clean up takes, and the confirm sentences.
 */
import { describe, expect, test } from "bun:test";
import type { AgentPane } from "../../shared/types.ts";
import { canEnd, cleanupSentence, cleanupTargets, endBlockedWhy, endSentence, namesText, sessionAge, windowsBySession } from "../src/lib/sessionsManage.ts";

const P = (session: string, windowId: string, windowIndex: string, windowName: string, extra: Partial<AgentPane> = {}): AgentPane =>
  ({ session, sessionId: `$${session}`, windowId, windowIndex, windowName, paneId: `%${windowId}`, path: "/p", agentCwds: [], agentSession: null, ...extra }) as AgentPane;

describe("windowsBySession", () => {
  test("windows per session in tmux order, one per window even with two panes", () => {
    const by = windowsBySession([
      P("orbit", "@2", "1", "logs"), P("orbit", "@1", "0", "api"), P("orbit", "@1", "0", "api"), P("moon", "@9", "0", "bash"),
    ]);
    expect(by.get("orbit")!.map((w) => w.name)).toEqual(["api", "logs"]);
    expect(by.get("moon")!.length).toBe(1);
  });
  test("a popup is not a window of the session", () => {
    const by = windowsBySession([P("orbit", "@1", "0", "api"), P("orbit", "@7", "1", "scratch", { popup: true })]);
    expect(by.get("orbit")!.map((w) => w.name)).toEqual(["api"]);
  });
});

describe("canEnd", () => {
  const s = { id: "$1", name: "orbit", windows: 1 };
  test("not the current session, not a locked one", () => {
    expect(canEnd(s, "orbit")).toBe(false);
    expect(canEnd({ ...s, locked: true }, "other")).toBe(false);
    expect(canEnd(s, "other")).toBe(true);
  });
  test("the reason is said for each", () => {
    expect(endBlockedWhy({ ...s, locked: true }, "x")).toContain("unlock it first");
    expect(endBlockedWhy(s, "orbit")).toContain("Switch somewhere else first");
    expect(endBlockedWhy(s, "x")).toBeNull();
  });
});

describe("cleanupTargets", () => {
  const sessions = [
    { id: "$1", name: "main", windows: 3 },
    { id: "$2", name: "idle1", windows: 1 },
    { id: "$3", name: "lockedone", windows: 1, locked: true },
    { id: "$4", name: "busy", windows: 1 },
    { id: "$5", name: "here", windows: 1 },
    { id: "$6", name: "nopanes", windows: 1 },
  ];
  const by = windowsBySession([
    P("main", "@1", "0", "a"), P("main", "@2", "1", "b"), P("main", "@3", "2", "c"),
    P("idle1", "@4", "0", "bash"), P("lockedone", "@5", "0", "bash"),
    P("busy", "@6", "0", "claude", { status: "working" }), P("here", "@7", "0", "bash"),
  ]);
  test("only idle one-window sessions that are neither locked nor current", () => {
    expect(cleanupTargets(sessions, "here", by).map((s) => s.name)).toEqual(["idle1"]);
  });
  test("a session whose window is not known is left alone", () => {
    expect(cleanupTargets(sessions, "here", by).some((s) => s.name === "nopanes")).toBe(false);
  });
  test("a waiting agent is not idle", () => {
    const b = windowsBySession([P("idle1", "@4", "0", "claude", { status: "waiting" })]);
    expect(cleanupTargets([sessions[1]!], "x", b)).toEqual([]);
  });
});

describe("sentences", () => {
  test("End names the session, its windows, and that it cannot be undone", () => {
    expect(endSentence("orbit", 3, ["api", "logs", "shell"])).toBe("End orbit? Its 3 windows (api, logs, shell) stop. This can't be undone.");
    expect(endSentence("moon", 1, ["bash"])).toBe("End moon? Its 1 window (bash) stops. This can't be undone.");
  });
  test("a long list is cut with a count", () => {
    expect(namesText(["a", "b", "c", "d", "e", "f"])).toBe("a, b, c, d +2 more");
    expect(namesText([""])).toBe("shell");
  });
  test("Clean up asks for one or many", () => {
    const t = [{ id: "1", name: "a", windows: 1 }, { id: "2", name: "b", windows: 1 }];
    expect(cleanupSentence(t)).toContain("End 2 sessions?");
    expect(cleanupSentence(t)).toContain("Each holds one window");
    expect(cleanupSentence([t[0]!])).toContain("End a?");
  });
});

describe("sessionAge", () => {
  const now = 1_700_000_000_000;
  const at = (secsAgo: number) => now / 1000 - secsAgo;
  test("says nothing when tmux gave no creation time", () => {
    expect(sessionAge(undefined, now)).toBe("");
    expect(sessionAge(0, now)).toBe("");
  });
  test("steps from just now to minutes, hours and days", () => {
    expect(sessionAge(at(30), now)).toBe("just now");
    expect(sessionAge(at(10 * 60), now)).toBe("10m old");
    expect(sessionAge(at(5 * 3600), now)).toBe("5h old");
    expect(sessionAge(at(3 * 86400), now)).toBe("3d old");
  });
  test("a clock skewed into the future reads as just now, never negative", () => {
    expect(sessionAge(at(-500), now)).toBe("just now");
  });
});
