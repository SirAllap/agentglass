/*
 * The card dock of the Jira list: what it draws is the Jira card, and the rules that make it the mockup's card.
 *
 * Source and static markup, no renderer: the dock draws JiraCard itself (so the sub-task menu reaches the rows), Esc closes it
 * only when nothing else took the key, the state chip is the one move menu, every icon-only control carries a tooltip and an
 * aria-label and no native title, and the GitHub tab has no workflow buttons.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { globalStubs } from "./stubGlobal";

const stubGlobal = globalStubs();
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000", search: "" });
const { escCloses, JiraDock, DockLayout, DOCK_W } = await import("../src/components/jira/list/JiraDock.tsx");
const { DockIcon, StateChip, stateStyle } = await import("../src/components/jira/DockParts.tsx");
const { PrTile } = await import("../src/components/jira/JiraCardPrs.tsx");
const { JiraProps } = await import("../src/components/jira/JiraFacts.tsx");

const at = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** A function's text, cut at its own closing brace and without comment lines. */
const fn = (src: string, head: string): string => {
  const from = src.indexOf(head);
  expect(from).toBeGreaterThanOrEqual(0);
  return strip(src.slice(from, src.indexOf("\n}\n", from) + 2));
};

const task = (o: Record<string, unknown> = {}) => ({
  id: "10001", customId: "ORB-9", title: "Merge small segments in a background worker", status: "In progress", statusColor: "#e5a50a", statusKind: "other",
  priority: "High", due: null, updated: Date.now() - 2 * 86_400_000, tags: ["index"], list: "Orbit", assignees: ["Ada Example"], people: [], sprint: "Sprint 18", points: 5,
  parent: { key: "ORB-1", title: "Vector index fold", type: "Epic" }, issueType: "Story", url: "https://acme.example/browse/ORB-9", mine: false, ...o,
}) as never;

describe("the dock", () => {
  test("empty, it says Select a card and holds the 620 width", () => {
    const html = renderToStaticMarkup(React.createElement(JiraDock, { source: {} as never, card: null, writable: false, onTask() {}, onClose() {}, onAllow() {} }));
    expect(html).toContain("Select a card");
    expect(html).toContain(`width:${DOCK_W}px`);
    expect(DOCK_W).toBe(620);
  });

  test("it draws the Jira card itself and hands the sub-task menu to its rows", () => {
    const src = strip(at("../src/components/jira/list/JiraDock.tsx"));
    const body = fn(at("../src/components/jira/list/JiraDock.tsx"), "export function DockLayout(");
    expect(body).toContain("<JiraCard key={card.id}");
    expect(body).toContain("onSubtaskMenu={onSubtaskMenu}");
    expect(body).toContain("<JiraHead t={card}");
    expect(src).not.toContain("source.CardPane");
  });

  test("Esc closes it unless a field, a menu or a dialog already has the key", () => {
    const key = (target: unknown, o: Record<string, unknown> = {}) => escCloses({ key: "Escape", defaultPrevented: false, target: target as EventTarget, ...o });
    const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, closest: () => null, ...extra });
    expect(key(el("DIV"))).toBe(true);
    expect(key(el("TEXTAREA"))).toBe(false);
    expect(key(el("INPUT"))).toBe(false);
    expect(key(el("DIV", { isContentEditable: true }))).toBe(false);
    expect(key(el("DIV", { closest: () => ({}) }))).toBe(false);
    expect(key(el("DIV"), { defaultPrevented: true })).toBe(false);
    expect(key(el("DIV"), { key: "Enter" })).toBe(false);
  });
});

describe("over the list", () => {
  const draw = (card: unknown, over: boolean) => renderToStaticMarkup(React.createElement(DockLayout, { source: {} as never, card: card as never, writable: false, onTask() {}, onClose() {}, onAllow() {}, over }));

  test("the choice draws the card as a dialog over the list, not the docked column", () => {
    const html = draw(task(), true);
    expect(html).toContain('data-testid="jira-card-over"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Merge small segments");
    expect(html).not.toContain(`width:${DOCK_W}px`);
    const docked = draw(task(), false);
    expect(docked).not.toContain("jira-card-over");
    expect(docked).toContain(`width:${DOCK_W}px`);
  });

  test("with no card there is nothing over the list", () => {
    expect(draw(null, true)).toBe("");
    expect(draw(null, false)).toContain("Select a card");
  });

  test("Esc inside the over-the-list card closes it, one inside another dialog does not", () => {
    const key = (closest: string | null) => escCloses({ key: "Escape", defaultPrevented: false, target: { tagName: "DIV", isContentEditable: false, closest: (sel: string) => (closest && sel.includes(closest) ? {} : null) } as never });
    expect(key('[role="dialog"]:not([data-slot="dock"])')).toBe(false);
    expect(key(null)).toBe(true);
    const src = fn(at("../src/components/jira/list/JiraDock.tsx"), "export function escCloses(");
    expect(src).toContain(':not([data-slot="dock"])');
  });
});

describe("icon-only controls", () => {
  test("a DockIcon carries the app's tooltip and an aria-label, never a native title", () => {
    const html = renderToStaticMarkup(React.createElement(DockIcon, { tip: { name: "Copy the link", text: "The Jira address." }, onClick() {}, children: "x" }));
    expect(html).toContain("data-tip=");
    expect(html).toContain('aria-label="Copy the link"');
    expect(html).not.toContain(" title=");
    expect(html).toContain("width:26px");
  });

  test("the header's icons are DockIcons with a tip each", () => {
    const head = fn(at("../src/components/jira/JiraFacts.tsx"), "export function JiraHead(");
    for (const name of ["Copy the link", "Open in Jira", "Read this card again", "Close"]) expect(head).toContain(`name: "${name}"`);
    expect(head).not.toMatch(/<(button|a)\b[^>]*\stitle=/);
  });
});

describe("the state chip", () => {
  test("is 26 high in the header and 22 on a row, tinted by the status, with a tick when finished", () => {
    expect(stateStyle("#e5a50a", false, 26).height).toBe(26);
    expect(stateStyle("#e5a50a", false, 22).height).toBe(22);
    const html = renderToStaticMarkup(React.createElement(StateChip, { status: "Done", done: true, h: 22 }));
    expect(html).toContain("Done");
    expect(html).toContain("<svg");
  });

  test("the header's chip is the move menu when writing is on, and a plain chip when it is off", () => {
    const head = fn(at("../src/components/jira/JiraFacts.tsx"), "export function JiraHead(");
    expect(head).toContain("<TrackerStatusPick tracker={TRACKERS.jira} task={t} query={key} onSaid={setSaid} onTask={onTask} chip={26} />");
    expect(head).toContain("Read-only. Turn changes on to move this card.");
  });
});

describe("the facts", () => {
  const facts = (writable: boolean, o: Record<string, unknown> = {}) =>
    renderToStaticMarkup(React.createElement(JiraProps, { t: task(o), writable, onTask() {}, onAllow() {} }));

  test("are tiles in a three-column grid with the usual names", () => {
    const html = facts(false);
    expect(html).toContain("agx-dk-facts");
    for (const l of ["Assignee", "Priority", "Sprint", "Points", "Labels", "Epic"]) expect(html).toContain(`>${l}<`);
    expect(html).toContain("Sprint 18");
    expect(html).toContain("#index");
  });

  test("read-only: one note, and a lock on the tiles that could be edited", () => {
    const html = facts(false);
    expect(html.split("This board is read-only.").length - 1).toBe(1);
    expect(html).toContain("agx-dk-lock");
  });

  test("a card without a sprint or points draws no empty tile for them", () => {
    const html = facts(false, { sprint: null, points: null });
    expect(html).not.toContain(">Sprint<");
    expect(html).not.toContain(">Points<");
  });
});

describe("the GitHub tab", () => {
  test("a pull request is a tile with no workflow step buttons", () => {
    const html = renderToStaticMarkup(React.createElement(PrTile, { l: { url: "https://github.com/acme/orbit/pull/412", number: 412, title: "acme/orbit#412", resolved: true, dev: { url: "", title: "Merge small segments", state: "OPEN", author: "Ada Example", reviewers: [], from: "fold/merge", into: "main", comments: 0, updated: 0 } } }));
    expect(html).toContain("agx-dk-prt");
    expect(html).toContain("#412 OPEN");
    expect(html).toContain("fold/merge → main");
    expect(html).not.toMatch(/Approve|Request changes|Merge pull request|Ready for QA/);
    expect(strip(at("../src/components/jira/JiraCardPrs.tsx"))).not.toMatch(/StepButton|workflow/i);
  });

  test("no hard-coded white: the tile uses the page background token", () => {
    const css = at("../src/components/jira/DockParts.tsx");
    const prt = css.split("\n").find((l) => l.startsWith(".agx-dk-prt{")) ?? "";
    expect(prt).toContain("background:var(--bg)");
    expect(prt).not.toMatch(/#fff|white/i);
  });
});

describe("the sheet", () => {
  test("only the spacing scale is used for gaps and paddings", () => {
    const css = at("../src/components/jira/DockParts.tsx");
    const sheet = css.slice(css.indexOf("export const DOCK_CSS"));
    const nums = [...sheet.matchAll(/(?:gap|padding(?:-left)?):([^;}]+)/g)].flatMap((m) => [...m[1]!.matchAll(/(\d+)px/g)].map((x) => Number(x[1])));
    expect(nums.length).toBeGreaterThan(0);
    for (const n of nums) expect([0, 2, 4, 6, 8, 12, 16, 24]).toContain(n);
  });
});

describe("the dock follows the stored choice", () => {
  test("JiraDock reads the card mode and hands it to the layout", () => {
    const body = fn(at("../src/components/jira/list/JiraDock.tsx"), "export function JiraDock(");
    expect(body).toContain('useCardMode() === "modal"');
    expect(body).toContain("<DockLayout");
  });
});
