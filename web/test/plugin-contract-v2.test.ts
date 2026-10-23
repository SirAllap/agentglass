/*
 * Review-plugin contract v2, drawn: the cost chip and the wait for an OK on a
 * run, the agreement and author chips on a finding, the buttons a plugin adds
 * to its own findings. The decisions live in lib/noteChips.ts; the screens
 * are checked as markup and as source (there is no renderer here).
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { agreementLabel, agreementTitle, agreementTone, costLabel, runHeaderState } from "../src/lib/noteChips.ts";
import { NoteCard, RunCard, type LocalNote, type LocalRun } from "../src/components/plugins/LocalReview.tsx";

const note = (over: Partial<LocalNote> = {}): LocalNote => ({
  id: "f-1", plugin: "acme-review", repo: "acme/orbit", number: 1042, severity: "high", title: "Guard runs after the loop",
  status: "open", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...over,
});
const run = (over: Partial<LocalRun> = {}): LocalRun => ({
  id: "run-1", plugin: "acme-review", repo: "acme/orbit", number: 1042, state: "done", title: "Local review", startedAt: 1_700_000_000_000, ...over,
});
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const src = (rel: string) => Bun.file(new URL(rel, import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
const review = code(await src("../src/components/plugins/LocalReview.tsx"));
const pr = code(await src("../src/components/PrPanel.tsx"));
const noop = () => {};

describe("the small marks, as decisions", () => {
  test("agreement reads k/n and its tone follows the room", () => {
    expect(agreementLabel({ k: 2, n: 3 })).toBe("2/3 agree");
    expect(agreementTone({ k: 3, n: 3 })).toBe("success");
    expect(agreementTone({ k: 2, n: 3 })).toBe("muted");
    expect(agreementTone({ k: 1, n: 3 })).toBe("warning");
    expect(agreementTone({ k: 1, n: 2 })).toBe("muted");
    expect(agreementTone({ k: 0, n: 1 })).toBe("warning");
    expect(agreementTitle({ k: 2, n: 3 })).toBe("2 of 3 second opinions agreed this is a real problem");
  });
  test("a cost is dollars and cents, and never reads as free below a cent", () => {
    expect(costLabel(0.42)).toBe("$0.42");
    expect(costLabel(12)).toBe("$12.00");
    expect(costLabel(0.004)).toBe("<$0.01");
    expect(costLabel(0)).toBe("$0");
    expect(costLabel(999.999)).toBe("$1000.00");
  });
  test("only needs-ok has buttons, and an answered one shows a sentence instead", () => {
    expect(runHeaderState({ state: "done" })).toEqual({ kind: "plain", label: "done" });
    expect(runHeaderState({ state: "needs-ok" })).toEqual({ kind: "waiting", label: "Needs your OK", canAnswer: true });
    expect(runHeaderState({ state: "needs-ok", decision: "approve" })).toMatchObject({ kind: "answered", canAnswer: false, label: "Approved, waiting for the plugin" });
    expect(runHeaderState({ state: "needs-ok", decision: "skip" })).toMatchObject({ kind: "answered", canAnswer: false, label: "Skipped, waiting for the plugin" });
  });
});

describe("a finding", () => {
  test("an old finding draws no marks", () => {
    const h = html(React.createElement(NoteCard, { n: note(), onStatus: noop }));
    expect(h).not.toContain("agree");
    expect(h).not.toContain("Raised by");
  });
  test("agreement and authors are chips on the title row", () => {
    const h = html(React.createElement(NoteCard, { n: note({ agreement: { k: 2, n: 3 }, by: ["agent-a", "agent-b"] }), onStatus: noop }));
    expect(h).toContain("2/3 agree");
    expect(h).toContain("Raised by agent-a");
    expect(h).toContain(">agent-b<");
    expect(h.indexOf("2/3 agree")).toBeLessThan(h.indexOf("Guard runs after the loop"));
  });
  test("the plugin's buttons follow Copy, in the declared order, with the shared compact button", () => {
    const h = html(React.createElement(NoteCard, { n: note(), onStatus: noop, actions: [{ id: "fix", label: "Fix" }, { id: "ask", label: "Ask" }], onAction: noop }));
    const at = (s: string) => h.indexOf(`>${s}</button>`);
    expect(at("Resolve")).toBeGreaterThan(-1);
    expect(at("Copy")).toBeGreaterThan(at("Dismiss"));
    expect(at("Fix")).toBeGreaterThan(at("Copy"));
    expect(at("Ask")).toBeGreaterThan(at("Fix"));
    // The same class every other button here carries, not a button of its own.
    const cls = (label: string) => /class="([^"]*)"/.exec(h.slice(h.lastIndexOf("<button", at(label))))![1];
    expect(cls("Fix")).toBe(cls("Copy"));
  });
  test("no actions declared, or nothing to call: no extra buttons", () => {
    expect(html(React.createElement(NoteCard, { n: note(), onStatus: noop, actions: [{ id: "fix", label: "Fix" }] }))).not.toContain(">Fix<");
    expect(html(React.createElement(NoteCard, { n: note(), onStatus: noop, onAction: noop }))).not.toContain(">Fix<");
  });
});

describe("a run header", () => {
  test("an old run draws as before: its state, no cost, no buttons", () => {
    const h = html(React.createElement(RunCard, { run: run(), notes: [], onStatus: noop, onDecide: noop }));
    expect(h).toContain("done");
    expect(h).not.toContain("$");
    expect(h).not.toContain("Approve run");
  });
  test("the cost is a chip", () => {
    expect(html(React.createElement(RunCard, { run: run({ costUsd: 0.42 }), notes: [], onStatus: noop }))).toContain("$0.42");
  });
  test("needs-ok says so and offers Approve run and Skip", () => {
    const h = html(React.createElement(RunCard, { run: run({ state: "needs-ok", costUsd: 2.4 }), notes: [], onStatus: noop, onDecide: noop }));
    expect(h).toContain("Needs your OK");
    expect(h).toContain(">Approve run</button>");
    expect(h).toContain(">Skip</button>");
    expect(h).toContain("$2.40");
  });
  test("an answered run keeps the sentence and loses the buttons", () => {
    const h = html(React.createElement(RunCard, { run: run({ state: "needs-ok", decision: "approve" }), notes: [], onStatus: noop, onDecide: noop }));
    expect(h).toContain("Approved, waiting for the plugin");
    expect(h).not.toContain("Approve run");
    expect(h).not.toContain(">Skip<");
  });
  test("without a handler the buttons are not drawn (a card shown where nothing can be answered)", () => {
    expect(html(React.createElement(RunCard, { run: run({ state: "needs-ok" }), notes: [], onStatus: noop }))).not.toContain("Approve run");
  });
});

describe("wiring, as source", () => {
  test("every place a finding is drawn passes the plugin's buttons", () => {
    const calls = pr.match(/<NoteCard\b[^\n]*/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      expect(c).toContain("actions={");
      expect(c).toContain("onAction={");
    }
  });
  test("the run card gets the decision and the buttons", () => {
    const c = /<RunCard\b[^\n]*/.exec(pr)![0];
    expect(c).toContain("onDecide=");
    expect(c).toContain("noteActions=");
  });
  test("a press goes to the plugin by the app's own routes, nowhere else", () => {
    expect(review).toContain("api.pluginNoteAction(");
    expect(review).toContain("api.pluginRunDecision(");
    expect(review).not.toMatch(/fetch\(/);
  });
  test("the buttons are the shared compact Button, and the chips use the repo's tokens", () => {
    const strip = (s: string) => s.slice(s.indexOf("function NoteMarks("), s.indexOf("function SevChip("));
    expect(strip(review)).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(review).toMatch(/<Button size="compact" tone="primary"[\s\S]*?>Approve run<\/Button>/);
  });
  test("an older app's answer (no noteActions) is read as none", () => {
    expect(review).toContain("data.noteActions ?? {}");
  });
});
