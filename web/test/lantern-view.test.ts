/*
 * THE LANTERN'S CARD, RENDERED.
 *
 * What one agent's card says: who, why it is stopped, what it is doing, what
 * git has, the numbers. The screen that lists them is the Agents screen
 * (agents-view.test.ts); the card is still drawn by the Settings preview.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LanternLine, NeedsYouCard, AgentCard, type LanternRow } from "../src/components/LanternView.tsx";

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
  test("what it said reads in the prose face — a person's or an agent's own words, not the app's mono chrome", () => {
    const html = renderToStaticMarkup(React.createElement(AgentCard, { r: rich(), onJump: () => {} }));
    expect(html).toContain("font-family:var(--font-prose)");
    const stopped = renderToStaticMarkup(React.createElement(NeedsYouCard, { r: waiting("permission") }));
    expect(stopped).toContain("font-family:var(--font-prose)");
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
