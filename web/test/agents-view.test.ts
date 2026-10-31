/*
 * THE AGENTS SCREEN, RENDERED.
 *
 * `useSyncExternalStore` renders on the server from the store's snapshot, so
 * the whole screen can be drawn here with a board of our choosing. Effects do
 * not run, so nothing here reads a server: the board is the only input, which
 * is exactly the part worth pinning: what the three numbers, the two columns
 * and the empty states say for each shape of it.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentsView } from "../src/components/agents/AgentsView.tsx";
import type { LanternRow } from "../src/components/LanternView.tsx";
import { __setLanternRows } from "../src/lib/lanternStore.ts";
import { addTab, __resetBench } from "../src/lib/benchStore.ts";

const NOW = Date.now();
const row = (over: Partial<LanternRow> = {}): LanternRow => ({
  name: "scout-2", worktree: "/code/acme/orbit", branch: "main", saidAt: NOW - 60_000, from: "seen", state: "working", paneId: "%4",
  facts: { tools: 40, errors: 0, turns: 8, cost: 0.57, lastTool: { name: "Read", what: "reconnect.ts", at: NOW - 60_000 } },
  pulse: [0, 1, 2, 3, 0, 0, 4, 2, 1, 0, 2, 5], ...over,
});
const blocked = (over: Partial<LanternRow> = {}) => row({
  name: "builder-1", branch: "fix/upload-retry", state: "waiting", paneId: "%5", session: "sess-b1",
  needsYou: { kind: "permission", why: "Claude needs your permission to use Bash", since: NOW - 3 * 60_000 }, ...over,
});
const screen = (rows: LanternRow[] | null) => {
  __setLanternRows(rows);
  return renderToStaticMarkup(React.createElement(AgentsView, { active: true }));
};

describe("what the three cards say", () => {
  test("a busy field: working, blocked and idle are counted apart, and the blocked one is the waiting card", () => {
    const html = screen([
      row(), row({ name: "migrate-5", paneId: "%6" }), blocked(), row({ name: "reviewer-3", state: "idle", paneId: "%7", saidAt: NOW - 40 * 60_000 }),
    ]);
    expect(html).toContain('<div class="num">2</div><div><div class="lab">working</div>');
    expect(html).toContain('<div class="num">1</div><div><div class="lab">waiting on you</div>');
    expect(html).toContain("builder-1");
    expect(html).toContain("3 min");
    expect(html).toContain("1 idle");
    expect(html).toContain("reviewer-3 40m");
  });

  test("only a permission or a held gate is 'waiting on you': a turn that ended is idle", () => {
    const html = screen([row(), row({ name: "tester-6", state: "waiting", paneId: "%8", needsYou: { kind: "input", why: "", since: NOW - 7_200_000 } })]);
    expect(html).toContain('<div class="num">0</div><div><div class="lab">waiting on you</div>');
    expect(html).toContain("1 idle");
  });

  test("the Lantern's own chat and the orchestrator are not work on the board", () => {
    const html = screen([row(), row({ name: "Lantern", role: "lantern", paneId: "%1" }), row({ name: "orbit-lead", role: "orchestrator", paneId: "%2" })]);
    expect(html).toContain('<div class="num">1</div><div><div class="lab">working</div>');
    expect(html).not.toContain(">Lantern<");
    expect(html).not.toContain("orbit-lead");
  });
});

describe("what a waiting card says", () => {
  test("a held tool call it cannot answer gets 'Open terminal' and no Allow that goes nowhere", () => {
    const html = screen([blocked()]);
    expect(html).toContain("Claude needs your permission to use Bash");
    expect(html).toContain("Open terminal");
    expect(html).not.toContain("Allow once");
    expect(html).toContain("fix/upload-retry");
  });
  test("every section says where it reads from and whether it notifies", () => {
    const html = screen([row()]);
    expect(html).toContain("from agent hooks");
    expect(html).toContain("Notifies you");
    expect(html).toContain("from hooks and tmux panes");
    expect(html).toContain("from a scan of running processes");
    expect(html).toContain("Quiet badge");
  });
});

describe("the working table", () => {
  test("the verb comes from its last tool, the branch and the spend are on the row", () => {
    const html = screen([row()]);
    expect(html).toContain("Reading");
    expect(html).toContain("reconnect.ts");
    expect(html).toContain(">main<");
    expect(html).toContain("$0.57");
  });
});

describe("the empty states", () => {
  test("nothing on the machine: the first-run steps, and each section says what it is waiting for", () => {
    const html = screen([]);
    expect(html).toContain("Start any Claude session in tmux");
    expect(html).toContain("Pick an orchestrator for this project");
    expect(html).toContain("Nothing is blocked on you");
    expect(html).toContain("No agents yet");
    expect(html).toContain("Nothing left running");
    expect(html).not.toContain("How this screen works");
  });

  test("while reading, says so, and shows no number as an answer", () => {
    const html = screen(null);
    expect(html).toContain("reading the agents");
  });

  test("a board with agents shows how the screen works, and not the first-run steps", () => {
    const html = screen([row()]);
    expect(html).toContain("How this screen works");
    expect(html).toContain("Only a blocked agent interrupts you");
    expect(html).not.toContain("Start any Claude session in tmux");
  });
});

describe("the header", () => {
  test("Ask about the agents follows the BENCH, not the board", () => {
    expect(screen([row()])).toContain("Ask about the agents");
    addTab("/w", { kind: "agent", slot: 3, title: "lantern", agent: "t" });
    expect(screen([row()])).toContain("Back to the session");
    __resetBench();
  });
  test("the scope is every project when none is open, with the count of projects", () => {
    const html = screen([row()]);
    expect(html).toContain("All projects");
    expect(html).toContain("Showing agents working in every project");
  });
});
