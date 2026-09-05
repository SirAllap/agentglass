/*
 * THE LANTERN, RENDERED.
 *
 * Translated from Herdr's Lantern: the first line is who needs you, a card per
 * agent stopped on you with why and the way there, the quiet ones folded. What
 * is pinned here is what the screen says in each state — because the previous
 * version of this surface said the same thing in every state, which is how it
 * came to be called "0 util".
 *
 * `useSyncExternalStore` renders on the server from the store's snapshot, so
 * the whole view can be drawn here with a board of our choosing.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { LanternView, LanternLine, NeedsYouCard, AgentCard, type LanternRow } from "../src/components/LanternView.tsx";
import { __setLanternRows } from "../src/lib/lanternStore.ts";
import { addTab, __resetBench } from "../src/lib/benchStore.ts";

const NOW = Date.now();
const row = (over: Partial<LanternRow> = {}): LanternRow => ({
  name: "orbit-1042", worktree: "/code/orbit-feature", branch: "feat/orbit-1042",
  saidAt: NOW - 60_000, from: "seen", state: "working", paneId: "%4", ...over,
});
const waiting = (kind: "permission" | "input" | "gate", over: Partial<LanternRow> = {}) => row({
  state: "waiting",
  needsYou: { kind, why: kind === "input" ? "Claude is waiting for your input" : "Claude needs your permission to use Bash", since: NOW - 5 * 60_000 },
  ...over,
});
const view = (rows: LanternRow[] | null) => {
  __setLanternRows(rows);
  return renderToStaticMarkup(React.createElement(LanternView, { active: true }));
};

describe("the first line", () => {
  test("says nobody needs you, calmly, when nobody does", () => {
    const html = view([row(), row({ name: "quiet", state: "idle", paneId: "%5" })]);
    expect(html).toContain("Nobody needs you right now");
    expect(html).toContain("1 working · 1 idle");
    expect(html).not.toContain("data-lantern-need");
  });

  test("says how many need you — a blockage — and, apart, how many finished and wait for you", () => {
    const html = view([waiting("permission"), waiting("input", { name: "two", paneId: "%6" }), row({ name: "busy", paneId: "%7" })]);
    expect(html).toContain("1 agent needs you");
    expect(html).toContain("1 finished, waiting for you");
    expect(html).toContain("Finished · waiting for you · 1");
    expect((html.match(/data-lantern-need/g) ?? []).length).toBe(2);
    // Two blockages count as two.
    expect(view([waiting("permission"), waiting("gate", { name: "two", paneId: "%6" })])).toContain("2 agents need you");
  });

  test("and says the field is empty rather than drawing an empty table", () => {
    const html = view([]);
    expect(html).toContain("Nobody is around");
    expect(html).toContain("POST /agents/status");
  });

  test("while reading, says so — and nothing else pretends to be an answer", () => {
    const html = view(null);
    expect(html).toContain("reading the agents");
    expect(html).not.toContain("Nobody");
  });
});

describe("an agent stopped on you", () => {
  test("gets a card: why, for how long, and Go", () => {
    const html = renderToStaticMarkup(React.createElement(NeedsYouCard, { r: waiting("permission"), onJump: () => {} }));
    expect(html).toContain("needs your permission");
    expect(html).toContain("Claude needs your permission to use Bash");
    expect(html).toContain("for 5m");
    expect(html).toContain("Go to %4");
  });

  test("a blockage is red; a turn that ended is amber", () => {
    expect(renderToStaticMarkup(React.createElement(NeedsYouCard, { r: waiting("permission") }))).toContain("var(--error)");
    expect(renderToStaticMarkup(React.createElement(NeedsYouCard, { r: waiting("gate") }))).toContain("held at the gate");
    const input = renderToStaticMarkup(React.createElement(NeedsYouCard, { r: waiting("input") }));
    expect(input).toContain("waiting for your next prompt");
    expect(input).not.toContain("var(--error)");
  });

  test("comes first, above every working row", () => {
    const html = view([row({ name: "busy-first-in-data" }), waiting("permission", { name: "stopped", paneId: "%9" })]);
    expect(html.indexOf("stopped")).toBeLessThan(html.indexOf("busy-first-in-data"));
  });
});

describe("the quiet ones", () => {
  test("are folded behind their count, and the working ones are not", () => {
    const html = view([row({ name: "busy" }), row({ name: "asleep-one", state: "idle", paneId: "%5" }), row({ name: "asleep-two", state: "idle", paneId: "%6" })]);
    expect(html).toContain("Idle · 2");
    expect(html).toContain("busy");
    expect(html).not.toContain("asleep-one");
  });
});

describe("a row", () => {
  test("keeps every column an agent that said nothing still has", () => {
    const html = renderToStaticMarkup(React.createElement(LanternLine, { r: row({ doing: undefined, left: "3 commits" }) }));
    expect(html).toContain("orbit-1042");
    expect(html).toContain("orbit-feature");
    expect(html).toContain("feat/orbit-1042");
    expect(html).toContain("3 commits");
    expect(html).not.toContain("it has not said");
  });

  test("says what it is on, when it has said", () => {
    expect(renderToStaticMarkup(React.createElement(LanternLine, { r: row({ doing: "reviewing PR #260" }) }))).toContain("reviewing PR #260");
  });

  test("a merged branch and an unmerged one do not read the same, and no answer says neither", () => {
    expect(renderToStaticMarkup(React.createElement(LanternLine, { r: row({ landed: true, landedInto: "main" }) }))).toContain("in main");
    expect(renderToStaticMarkup(React.createElement(LanternLine, { r: row({ landed: false, landedInto: "main" }) }))).toContain("not in main");
    const none = renderToStaticMarkup(React.createElement(LanternLine, { r: row({ landed: undefined }) }));
    expect(none).not.toContain("merged");
    expect(none).not.toContain("not in");
  });

  test("has Go only when there is a pane to go to", () => {
    expect(renderToStaticMarkup(React.createElement(LanternLine, { r: row(), onJump: () => {} }))).toContain("Go to %4");
    expect(renderToStaticMarkup(React.createElement(LanternLine, { r: row({ paneId: undefined }), onJump: () => {} }))).not.toContain("Go to");
  });
});

describe("the cards", () => {
  const rich = (): LanternRow => ({
    name: "orbit-1042", from: "seen", state: "working", paneId: "%4", session: "s", worktree: "/w/orbit-1042", branch: "feat/orbit-1042", landed: false, landedInto: "main",
    facts: { model: "claude-opus-5", tools: 412, errors: 3, turns: 96, cost: 41.2, startedAt: Date.now() - 3 * 3_600_000, lastSeen: Date.now(),
      lastTool: { name: "Bash", what: "Run the export suite against the fixture", at: Date.now() - 60_000 }, lastAsk: { text: "Reproduce first, then fix", at: Date.now() - 600_000 }, permissionMode: "bypassPermissions" },
    git: { dirty: 4, ahead: 2, lastCommit: { subject: "test(export): pin the dropped last page", at: Date.now() }, at: Date.now() },
  });
  test("say who, what now (the last tool in its own words), what was asked, what git has, the numbers, and yolo", () => {
    const html = renderToStaticMarkup(React.createElement(AgentCard, { r: rich(), onJump: () => {} }));
    for (const s of ["orbit-1042", "Opus", "Run the export suite against the fixture", "Bash", "Reproduce first, then fix",
      "2</span><span>commits ahead", "4</span><span>files changed", "test(export): pin the dropped last page",
      "412</span><span>calls", "96</span><span>turns", "3</span><span>errors", "$41.2", "yolo", "Go to %4", "working"]) {
      expect(html, s).toContain(s);
    }
  });
  test("a line with nothing to say is left out — no dashes, no placeholders", () => {
    const bare: LanternRow = { name: "%9", from: "seen", state: "idle" };
    const html = renderToStaticMarkup(React.createElement(AgentCard, { r: bare }));
    for (const s of ["now", "asked", "git", "calls", "turns", "Go"]) expect(html, s).not.toContain(`>${s}<`);
  });
  test("on the base branch with nothing ahead and nothing changed, git says nothing", () => {
    const r = rich(); r.git = { dirty: 0, ahead: 0, lastCommit: { subject: "Merge pull request #1", at: Date.now() }, at: Date.now() };
    expect(renderToStaticMarkup(React.createElement(AgentCard, { r }))).not.toContain("Merge pull request");
  });
  test("the Lantern's own chat is set aside: not counted, not listed, and the header says the chat is open", () => {
    __setLanternRows([
      { name: "Lantern", from: "seen", state: "idle", role: "lantern", paneId: "%1" },
      { name: "busy", from: "seen", state: "working", paneId: "%2" },
    ]);
    const html = renderToStaticMarkup(React.createElement(LanternView, { active: true }));
    expect(html).toContain("1 working · 0 idle");
    expect(html).not.toContain('title="Lantern"');
    // The label follows the BENCH, not the board: a row for a chat just ended lingers.
    expect(html).toContain("Ask about the agents");
    addTab("/w", { kind: "agent", slot: 3, title: "lantern", agent: "t" });
    expect(renderToStaticMarkup(React.createElement(LanternView, { active: true }))).toContain("Back to the chat");
    __resetBench();
  });
});

describe("the prompt cache, counted down", () => {
  test("warm within the window from the last turn, cold after it, and absent with nothing to count from", () => {
    const now = Date.now();
    const r: LanternRow = { name: "a", from: "seen", state: "working", facts: { tools: 1, errors: 0, turns: 1, cost: 0, lastTool: { name: "Bash", what: "x", at: now - 2 * 60_000 } } };
    const warm = renderToStaticMarkup(React.createElement(AgentCard, { r, cacheTtlMs: 5 * 60_000 }));
    expect(warm).toMatch(/cache 2:5\d|cache 3:00/);
    const cold = renderToStaticMarkup(React.createElement(AgentCard, { r, cacheTtlMs: 60_000 }));
    expect(cold).toContain("cache cold");
    const none = renderToStaticMarkup(React.createElement(AgentCard, { r: { name: "b", from: "seen", state: "idle" }, cacheTtlMs: 60_000 }));
    expect(none).not.toContain("cache");
  });
});

describe("scheduled starts", () => {
  test("the section lists waiting ones with a Cancel and fired ones with what happened; nothing draws for none", async () => {
    const { ScheduledSection } = await import("../src/components/LanternSchedule.tsx");
    const now = Date.now();
    const items = [
      { id: "a", name: "nightly", cwd: "/w/orbit", kind: "claude", prompt: "run it", yolo: true, due: now + 3_600_000, created: now, firedAt: null, cancelledAt: null, result: "" },
      { id: "b", name: "morning", cwd: "/w/orbit", kind: "claude", prompt: "", yolo: false, due: now - 3_600_000, created: now - 7_200_000, firedAt: now - 3_600_000, cancelledAt: null, result: "started as morning in pane %31" },
      { id: "c", name: "broken", cwd: "/w/gone", kind: "claude", prompt: "", yolo: false, due: now - 60_000, created: now - 7_200_000, firedAt: now - 60_000, cancelledAt: null, result: "did not start: its checkout is no longer in the open project" },
    ];
    const html = renderToStaticMarkup(React.createElement(ScheduledSection, { items, onCancel: () => {} }));
    expect(html).toContain("Scheduled · 1 · 2 fired");
    expect(html).toContain("nightly");
    expect(html).toContain("run it");
    expect(html).toContain("· skips permission prompts");
    expect(html).toContain("started as morning in pane %31");
    expect(html).toContain("no longer in the open project");
    expect((html.match(/>Cancel</g) ?? []).length, "only the waiting one can be cancelled").toBe(1);
    expect(renderToStaticMarkup(React.createElement(ScheduledSection, { items: [], onCancel: () => {} }))).toBe("");
  });
  test("the Lantern offers the dialog from its header and reads the schedules through the api", () => {
    const view = readFileSync(new URL("../src/components/LanternView.tsx", import.meta.url), "utf8");
    expect(view).toContain("⏰ Schedule…");
    expect(view).toContain("api.agentSchedules()");
    expect(view).toContain("<ScheduledSection items={schedules} onCancel={cancelSchedule} />");
    expect(view).toContain("<ScheduleDialog open={scheduling}");
  });
});

