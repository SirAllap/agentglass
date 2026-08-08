/*
 * Which pane the "waiting on you" panel offers to take you to.
 *
 * The complaint this whole thread came from: "no sé de qué agente habla y no sé
 * en qué pane y no me lleva a ningún sitio". The last third took three rounds.
 * The panel could only join a session to a pane by the directory the agent was
 * running in, and that join has to decline whenever two agents share a
 * worktree — which on this machine is most of the time, so the honest answer
 * was usually a list of maybes or a sentence saying it could not tell.
 *
 * The exact answer was already being collected: Claude Code's hooks carry the
 * pane they fired from, and the server records pane → session on every event.
 * `paneChoices` is where that arrives — an id the agent reported about itself,
 * so no directory is consulted and no guess is made.
 *
 * The fallback stays, and these tests hold both halves. An agent started
 * outside a hook-wired CLI never reports a pane, and there is no reason it
 * should lose the behaviour it had.
 */
import { describe, expect, test } from "bun:test";
import { paneChoices } from "../src/lib/panePick.ts";
import type { AgentPane } from "../../shared/types.ts";

const APP = "/home/dev/code/orbit";
const WT = "/home/dev/code/orbit-WEB-1042";

const pane = (over: Partial<AgentPane> & { paneId: string }): AgentPane => ({
  session: "0", sessionId: "$0", windowId: "@1", windowIndex: "2", windowName: "AI",
  path: APP, agentCwds: [], agentSession: null, ...over,
});

/** Two agents in one worktree and one elsewhere — the arrangement the directory
 *  join cannot resolve, and the reason the exact one was needed. */
const PANES = [
  pane({ paneId: "%1", windowName: "Editor", agentCwds: [] }),
  pane({ paneId: "%2", windowName: "AI00", agentCwds: [WT], agentSession: "sess-a" }),
  pane({ paneId: "%3", windowName: "AI01", agentCwds: [WT], agentSession: "sess-b" }),
  pane({ paneId: "%4", windowName: "solo", agentCwds: [APP] }),
];

describe("when the session reported its own pane", () => {
  test("that pane is the answer, and no guesses are offered beside it", () => {
    const { exact, hits } = paneChoices(PANES, { sessionId: "sess-b", cwd: WT });
    expect(exact?.paneId).toBe("%3");
    // The directory match would have returned both %2 and %3 here. Showing them
    // as alternatives next to a certain answer would be asking the user to pick
    // between knowledge and a coin flip.
    expect(hits).toEqual([]);
  });

  test("the two agents sharing a worktree are told apart", () => {
    // The exact case the old join had to decline on.
    expect(paneChoices(PANES, { sessionId: "sess-a", cwd: WT }).exact?.paneId).toBe("%2");
    expect(paneChoices(PANES, { sessionId: "sess-b", cwd: WT }).exact?.paneId).toBe("%3");
  });

  test("the directory is not consulted at all", () => {
    // An agent that has changed directory, or whose alert carries the project
    // rather than the worktree, still lands in the right pane.
    const { exact } = paneChoices(PANES, { sessionId: "sess-b", cwd: "/somewhere/else" });
    expect(exact?.paneId).toBe("%3");
  });

  test("no cwd at all is still answerable", () => {
    expect(paneChoices(PANES, { sessionId: "sess-a", cwd: null }).exact?.paneId).toBe("%2");
  });
});

describe("when nothing reported a pane", () => {
  test("one pane in the directory is still offered", () => {
    // Unchanged behaviour for every agent not started under a hook-wired CLI.
    const { exact, hits } = paneChoices(PANES, { sessionId: "sess-unknown", cwd: APP });
    expect(exact).toBeNull();
    expect(hits.map((p) => p.paneId)).toEqual(["%4"]);
  });

  test("several in one directory come back as candidates, not as a pick", () => {
    const { exact, hits } = paneChoices(PANES, { sessionId: "sess-unknown", cwd: WT });
    expect(exact).toBeNull();
    expect(hits.map((p) => p.paneId)).toEqual(["%2", "%3"]);
  });

  test("a session with no id does not match a pane that has no note", () => {
    // Both sides would be falsy, and an equality test written the obvious way
    // would have sent every OTel-only alert to the first unclaimed pane.
    const orphan = [pane({ paneId: "%7", agentCwds: [APP] })];
    expect(paneChoices(orphan, { sessionId: "", cwd: null }).exact).toBeNull();
  });

  test("a directory nothing runs in offers nothing", () => {
    const { exact, hits } = paneChoices(PANES, { sessionId: "", cwd: "/tmp" });
    expect(exact).toBeNull();
    expect(hits).toEqual([]);
  });

  test("an empty pane list is not an error", () => {
    // tmux not running, or not installed at all.
    expect(paneChoices([], { sessionId: "sess-a", cwd: APP })).toEqual({ exact: null, hits: [] });
  });
});
