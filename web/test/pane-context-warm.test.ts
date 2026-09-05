/*
 * "It takes ages to analyse and show the drawer with the PR, card, git and diff…
 * especially after restarting agentglass… it stays on Reading this pane…
 * now they have loaded, after a good while."
 *
 * Two cold starts, one on top of the other.
 *
 *  1. The route answers about the pane tmux has SELECTED, so the panel could
 *     only ask about a pane after selecting it: one round trip per pane, made
 *     as the pointer reached it. On a six-pane grid that is six discoveries,
 *     one at a time, each one behind a "Reading this pane…".
 *  2. The answer lived in the component, so a relaunch threw away everything
 *     the last hour had learned.
 *
 * So the window is asked for in one request while nobody is waiting, and what
 * it learns is written down. What makes writing it down safe is `nextSeen`: an
 * entry survives only while the SAME agent is still in that pane.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { nextSeen, readPaneSeen, writePaneSeen } from "../src/lib/paneWorktree.ts";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
} as unknown as Storage;

beforeEach(() => store.clear());

describe("the memory survives a restart", () => {
  test("what was written comes back", () => {
    writePaneSeen(new Map([["@1:%2", { root: "/home/dev/orbit-1042", session: "s1" }]]));
    expect(readPaneSeen()).toEqual([["@1:%2", { root: "/home/dev/orbit-1042", session: "s1" }]]);
  });

  test("and a stale one cannot outlive its conversation", () => {
    /* The guard that makes this safe to write down at all: the entry is kept
       only while the agent that gave it is still there. A `/clear` starts a new
       session id, and the answer goes. */
    const prev = { root: "/home/dev/orbit-1042", session: "s1" };
    expect(nextSeen(prev, null, "s1")).toEqual(prev);
    expect(nextSeen(prev, null, "s2")).toBe(null);
    expect(nextSeen(prev, null, "")).toBe(null);
  });

  test("rubbish on disk is not trusted", () => {
    store.set("agentglass.term.paneSeen", '[["@1:%2",{"root":42}],"nope"]');
    expect(readPaneSeen()).toEqual([]);
  });

  test("it is a warm start, not a record", () => {
    // Pane ids are recycled and windows come and go.
    const many = new Map(Array.from({ length: 80 }, (_, i) => [`@1:%${i}`, { root: `/r${i}`, session: "s" }] as const));
    writePaneSeen(many as Map<string, { root: string; session: string }>);
    expect(readPaneSeen().length).toBe(60);
    // The oldest are the ones dropped.
    expect(readPaneSeen()[0]![0]).toBe("@1:%20");
  });
});

describe("the whole window, in one request", () => {
  const term = readFileSync(new URL("../src/components/TerminalPanel.tsx", import.meta.url), "utf8");
  const index = readFileSync(new URL("../../server/src/index.ts", import.meta.url), "utf8");

  test("the route can answer for every pane, not just the selected one", () => {
    expect(index).toContain('url.searchParams.get("all") === "1"');
    expect(index).toContain("panesWithPids(lastTmuxTarget()?.socket, win)");
  });

  test("and it comes off the same list-panes call", () => {
    // Not one subprocess per pane: this is polled while the grid is open.
    const ctl = readFileSync(new URL("../../server/src/tmuxctl.ts", import.meta.url), "utf8");
    const fn = ctl.slice(ctl.indexOf("export function panesWithPids"));
    expect((fn.slice(0, fn.indexOf("\nexport ")).match(/tmux\(socket, \[/g) ?? []).length).toBe(1);
  });

  test("the hover reads the book before the network", () => {
    expect(term).toContain("const booked = focusPane ? paneBook.current.get(focusPane) : undefined;");
    expect(term).toContain("booked ?? await api.paneDirs(focusWin)");
  });

  test("and the book is filled in the background", () => {
    expect(term).toContain("api.paneDirsAll(focusWin)");
  });
});
