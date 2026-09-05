/*
 * The tab strip, shaped like the one on the computer.
 *
 * The desk shows tmux WINDOWS — `1 Orbit.AI  2 AI00  3 AI01` — and the phone
 * was drawing the raw pane list, so a split window appeared as two tabs with
 * the same name and the strip did not look like the strip it was mirroring.
 */
import { describe, expect, test } from "bun:test";
import { bestSession, paneTabs, sessionsOf } from "../src/terminal/tabs.ts";
import type { AgentPane } from "../../shared/types.ts";

const pane = (over: Partial<AgentPane>): AgentPane => ({
  session: "orbit", sessionId: "$1", windowId: "@1", windowIndex: "1",
  windowName: "Orbit.AI", paneId: "%1", path: "/home/x/code/orbit", agentCwds: [],
  agentSession: null, ...over,
});

describe("windows as tabs", () => {
  test("one pane is one tab, named the way tmux names it", () => {
    const tabs = paneTabs([pane({}), pane({ windowId: "@2", windowIndex: "2", windowName: "AI00", paneId: "%2" })]);
    expect(tabs.map((t) => t.label)).toEqual(["1 Orbit.AI", "2 AI00"]);
  });

  test("a split window becomes one tab per pane, suffixed", () => {
    const tabs = paneTabs([
      pane({ paneId: "%1" }),
      pane({ paneId: "%2" }),
      pane({ windowId: "@2", windowIndex: "2", windowName: "AI00", paneId: "%3" }),
    ]);
    expect(tabs.map((t) => t.label)).toEqual(["1 Orbit.AI·p1", "1 Orbit.AI·p2", "2 AI00"]);
  });

  test("a lone pane is never suffixed", () => {
    // `·p1` on its own reads as "there is a p2 somewhere", and there is not.
    expect(paneTabs([pane({})])[0]!.label).toBe("1 Orbit.AI");
  });

  test("window 10 does not sort between 1 and 2", () => {
    /*
     * tmux's window index is a STRING, and sorting it as one is how a strip
     * ends up 1, 10, 11, 2 — which is the strip nobody can find anything in.
     */
    const tabs = paneTabs([2, 10, 1, 11].map((i) =>
      pane({ windowId: `@${i}`, windowIndex: String(i), windowName: `w${i}`, paneId: `%${i}` })));
    expect(tabs.map((t) => t.label)).toEqual(["1 w1", "2 w2", "10 w10", "11 w11"]);
  });

  test("two servers can both have window @1", () => {
    // Keyed on session and window, or one session's pane lands in another's tab.
    const tabs = paneTabs([
      pane({ session: "a", sessionId: "$1", paneId: "%1" }),
      pane({ session: "b", sessionId: "$2", paneId: "%2" }),
    ]);
    expect(tabs).toHaveLength(2);
    expect(tabs.every((t) => !t.label.includes("·p"))).toBe(true);
    expect(sessionsOf(tabs)).toEqual(["a", "b"]);
  });

  test("and two servers can both have session $0 and window @0", () => {
    /*
     * The case the one above did not cover, and the one that actually happened.
     * tmux ids are per SERVER and the pane list is every server on the machine,
     * so an isolated test server running beside another gives two rows with the
     * same `$0 @0` — and keying on that pair welded a two-pane window and a
     * four-pane window into one six-pane window labelled `0 sh·p1` through
     * `0 sh·p6`, half of whose tabs pointed into the wrong server.
     *
     * Nothing on the wire distinguishes them: the socket is a filesystem path
     * and stays on the server's side. The session's NAME does, and tmux will
     * not let one server hold two of those.
     */
    const tabs = paneTabs([
      pane({ session: "qa", sessionId: "$0", windowId: "@0", windowIndex: "0", windowName: "sh", paneId: "%0" }),
      pane({ session: "qa", sessionId: "$0", windowId: "@0", windowIndex: "0", windowName: "sh", paneId: "%1" }),
      pane({ session: "work", sessionId: "$0", windowId: "@0", windowIndex: "0", windowName: "probe", paneId: "%0" }),
      pane({ session: "work", sessionId: "$0", windowId: "@0", windowIndex: "0", windowName: "probe", paneId: "%1" }),
    ]);
    expect(tabs.map((t) => t.label)).toEqual(["0 sh·p1", "0 sh·p2", "0 probe·p1", "0 probe·p2"]);
    expect(sessionsOf(tabs)).toEqual(["qa", "work"]);
  });

  test("an agent under a pane is carried, because it is why you open it", () => {
    const tabs = paneTabs([pane({ agentCwds: ["/home/x/code/orbit"] })]);
    expect(tabs[0]!.agent).toBe(true);
    expect(tabs[0]!.where).toBe("orbit");
  });

  test("nothing in, nothing out", () => {
    expect(paneTabs([])).toEqual([]);
    expect(sessionsOf([])).toEqual([]);
  });
});

describe("which session the terminal opens on", () => {
  const p = (session: string, window: number, agent = false): AgentPane => ({
    session, sessionId: `$${session.length}`, windowId: `@${window}`,
    windowIndex: String(window), windowName: `w${window}`,
    paneId: `%${session}${window}`, path: `/home/x/code/${session}`,
    agentCwds: agent ? [`/home/x/code/${session}`] : [], agentSession: null,
  });

  test("where the work is, not the first name alphabetically", () => {
    /*
     * The bug this exists for, seen in a screenshot of the running app: the
     * strip is sorted by name so it stays put between refreshes, and on a real
     * machine that opened a session holding one idle shell ahead of the one
     * with six windows and five agents. The answer to "where are my tabs" was
     * "three taps to the right, off the edge of the screen".
     */
    const tabs = paneTabs([
      p("aaa-idle", 1),
      p("work", 1, true), p("work", 2, true), p("work", 3),
    ]);
    expect(bestSession(tabs)).toBe("work");
  });

  test("and failing agents, the most windows", () => {
    const tabs = paneTabs([p("aaa", 1), p("busy", 1), p("busy", 2), p("busy", 3)]);
    expect(bestSession(tabs)).toBe("busy");
  });

  test("a tie keeps its place, so the strip does not shuffle on every refresh", () => {
    const tabs = paneTabs([p("beta", 1), p("alpha", 1)]);
    expect(bestSession(tabs)).toBe("alpha");
    expect(bestSession(paneTabs([p("alpha", 1), p("beta", 1)]))).toBe("alpha");
  });

  test("nothing to open when there is nothing", () => {
    expect(bestSession([])).toBeNull();
  });
});

describe("the sessions this app made itself", () => {
  test("never appear as somewhere to go", () => {
    /*
     * Opening a tab creates a grouped session named `agx-phone-…` so the phone
     * gets its own client. It holds the SAME windows as the session it joined,
     * so leaving it in the list put a duplicate of every tab in the picker —
     * one more each time a tab was opened.
     */
    const real = { session: "work", sessionId: "$1", windowId: "@1", windowIndex: "1",
      windowName: "w", paneId: "%1", path: "/home/x/code/work", agentCwds: [], agentSession: null };
    const tabs = paneTabs([real, { ...real, session: "agx-phone-1-abc123", sessionId: "$9", paneId: "%9" }]);
    expect(tabs).toHaveLength(1);
    expect(sessionsOf(tabs)).toEqual(["work"]);
  });

  test("and a session merely NAMED like one is not ours", () => {
    // The prefix is anchored: somebody's own `my-agx-phone-notes` is theirs.
    const p = { session: "my-agx-phone-notes", sessionId: "$1", windowId: "@1", windowIndex: "1",
      windowName: "w", paneId: "%1", path: "/x", agentCwds: [], agentSession: null };
    expect(paneTabs([p])).toHaveLength(1);
  });
});

describe("a tmux floating window", () => {
  test("is not somewhere to go", () => {
    const base = { sessionId: "$1", windowId: "@1", windowIndex: "1", windowName: "w",
      path: "/x", agentCwds: [], agentSession: null };
    const tabs = paneTabs([
      { ...base, session: "work", paneId: "%1" },
      { ...base, session: "scratch", sessionId: "$2", paneId: "%2", popup: true },
    ]);
    expect(sessionsOf(tabs)).toEqual(["work"]);
  });
});

describe("sessions nobody is looking at", () => {
  const base = { sessionId: "$1", windowId: "@1", windowIndex: "1", windowName: "w",
    path: "/x", agentCwds: [] as string[], agentSession: null };

  test("are left out, the way the desk leaves them out", () => {
    const tabs = paneTabs([
      { ...base, session: "work", paneId: "%1", attached: true },
      { ...base, session: "leftover", sessionId: "$2", paneId: "%2", attached: false },
    ]);
    expect(sessionsOf(tabs)).toEqual(["work"]);
  });

  test("unless an agent is running in one", () => {
    // The one case where a session nobody is watching still matters.
    const tabs = paneTabs([
      { ...base, session: "work", paneId: "%1", attached: true },
      { ...base, session: "headless", sessionId: "$2", paneId: "%2", attached: false,
        agentCwds: ["/x"] },
    ]);
    expect(sessionsOf(tabs).sort()).toEqual(["headless", "work"]);
  });

  test("and a server that did not say stays visible", () => {
    // `attached` absent means an older build answered. Hiding on a missing
    // field would empty the screen against every server but the newest.
    expect(paneTabs([{ ...base, session: "work", paneId: "%1" }])).toHaveLength(1);
  });
});

/*
 * A session on somebody else's tmux server is not in this list.
 *
 * `listPanes` walks the socket directory and answers for every server that has
 * a client, so a tmux the test suite left running — or another agent's —
 * arrives beside the one you work in. On a desk that is a row to scroll past;
 * on a phone the strip IS the screen.
 *
 * Reproduced on a rig with two isolated servers, each with a client, through
 * the real `/terminal/panes`:
 *
 *     canAttach: true   panes: 2
 *       agx-probe-9f2  win 0 sh      pane %0  attached true   <- a test's
 *       work           win 0 editor  pane %0  attached true   <- the real one
 *
 * and the strip that came out of it:
 *
 *     before ->  0 sh (agx-probe-9f2)  |  0 editor (work)
 *     after  ->  0 editor (work)
 *
 * NOTHING ELSE ON THAT WIRE TOLD THEM APART, which is why the fix is a new
 * field rather than a cleverer read of the old ones. `attached` was true for
 * both. The pane ids were BOTH `%0` — ids are per server, so they cannot
 * separate servers and cannot even identify a pane across them. And the name
 * is not a rule: three servers on this machine each held a session called
 * `agentglass-understudy`, so a prefix test would have been a guess wearing a
 * rule's clothes.
 *
 * The server has the socket and says only whether it is its own, so the path
 * still stays on its side of the wire.
 */
describe("servers that are not ours", () => {
  const base = pane({ attached: true });

  test("a session on another tmux server is dropped", () => {
    const tabs = paneTabs([
      { ...base, session: "work", paneId: "%1", own: true },
      { ...base, session: "agx-probe-9f2", sessionId: "$2", paneId: "%2", own: false },
    ]);
    expect(tabs.map((t) => t.session)).toEqual(["work"]);
  });

  test("even when an agent is running in it", () => {
    // The exception `attached` makes does NOT extend here. An agent in a test's
    // tmux is a test's agent, and opening its pane on a phone is a coin flip
    // between two servers that both answer to that id.
    const tabs = paneTabs([
      { ...base, session: "work", paneId: "%1", own: true },
      { ...base, session: "agx-probe-9f2", sessionId: "$2", paneId: "%2", own: false,
        agentCwds: ["/tmp/agx-probe"] },
    ]);
    expect(tabs.map((t) => t.session)).toEqual(["work"]);
  });

  test("but a server too old to say keeps everything", () => {
    // Absent is a third answer, the same as it is for `attached`. It is also
    // what a server answers when this app has never attached anything and has
    // no server of its own to compare against — and emptying the strip there
    // would be a phone that shows nothing on a fresh profile.
    const tabs = paneTabs([
      { ...base, session: "work", paneId: "%1" },
      { ...base, session: "other", sessionId: "$2", paneId: "%2" },
    ]);
    expect(tabs.map((t) => t.session)).toEqual(["other", "work"]);
  });

  test("and `own` never revives a session the other rules dropped", () => {
    // Ours, and still detached with nothing running in it. One filter saying
    // yes is not the others saying yes.
    const tabs = paneTabs([
      { ...base, session: "work", paneId: "%1", own: true },
      { ...base, session: "leftover", sessionId: "$2", paneId: "%2", own: true, attached: false },
      { ...base, session: "popup", sessionId: "$3", paneId: "%3", own: true, popup: true },
      { ...base, session: "agx-phone-%9-abc", sessionId: "$4", paneId: "%4", own: true },
    ]);
    expect(tabs.map((t) => t.session)).toEqual(["work"]);
  });
});
