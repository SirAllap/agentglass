/*
 * Jira's Settings page, drawn from settings handed to it: no request is made.
 * The map's units are the projects that count with the site's own statuses, a
 * step is covered where its status exists, and no status the page names is
 * written in the page's source.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";
import { globalStubs } from "./stubGlobal";
// The libraries below read the window's storage when they load, so they load under a stub that goes back when the file ends.
globalStubs()("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const { JiraSettingsView } = await import("../src/components/jira/JiraSettingsView.tsx");
const { JIRA, jiraAdd, jiraBlocks, jiraRemove, jiraSteps } = await import("../src/lib/jiraWorkflow.ts");
const { allStatuses, coverage } = await import("../src/lib/workflowMap.ts");
import type { JiraViewProps } from "../src/components/jira/JiraSettingsView.tsx";
import type { MapSpace } from "../src/lib/workflowMap.ts";
import type { JiraStatus, JiraSteps } from "../../shared/providers.ts";
import type { JiraUnit } from "../../shared/jiraStatusUnits.ts";

// Invented statuses, none of them a word the page's source may hold.
const UNITS: JiraUnit[] = [
  { id: "ORBIT", name: "Orbit core", cards: 4, statuses: [{ status: "Queued", type: "open" }, { status: "Building", type: "open" }, { status: "Peer check", type: "open" }, { status: "Shipped", type: "done" }] },
  { id: "DOCS", name: "Orbit docs", cards: 1, statuses: [{ status: "Drafting", type: "open" }, { status: "Peer check", type: "open" }, { status: "Published", type: "done" }] },
  { id: "OPS", name: "Orbit ops", counted: false, statuses: [{ status: "Waiting", type: "open" }, { status: "Closed out", type: "done" }] },
];
const STATUS: JiraStatus = { connected: true, site: "acme.example", kind: "cloud", auth: "basic", api: 3, deployment: "cloud", account: "Ada Test", prefixes: ["ORBIT"], writes: false, writeKinds: { move: true, comment: true, link: true, assign: true } };
const off = { enabled: false, blocks: [] };
const STEPS: JiraSteps = {
  handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["Peer check"] }, { type: "link" }] },
  review: off,
  merge: { enabled: true, blocks: [{ type: "move", statusNames: ["Shipped"] }] },
};
const view = (o: Partial<JiraViewProps> = {}) =>
  renderToStaticMarkup(React.createElement(JiraSettingsView, {
    status: STATUS, writes: false, steps: STEPS, overrides: [], units: { kind: "ok", units: UNITS, at: Date.now(), counted: [] }, views: { views: 2, folders: 0 }, note: null,
    onWrites() {}, onWriteKind() {}, onReplace() {}, onSteps: async () => true, onReread() {}, onClearOverride() {}, onOpenTab() {}, onDisconnect() {}, ...o,
  } as JiraViewProps));

const asSpaces = (u: JiraUnit[]): MapSpace[] => u.filter((x) => x.counted !== false).map((x) => ({ id: x.id, name: x.name, statuses: x.statuses }));

describe("the Jira page, drawn from handed-in settings", () => {
  test("write permissions: four kinds, each its own switch bound to its setting, and a kind that is off draws off", () => {
    const html = view({ status: { ...STATUS, writeKinds: { move: true, comment: false, link: true, assign: true } } });
    for (const k of ["move", "comment", "link", "assign"]) expect(html).toContain(`data-setting-id="jira.writes.${k}"`);
    for (const t of ["Move cards between steps", "Comment on a card", "Link a pull request to its card", "Assign a person"]) expect(html).toContain(t);
    // Three on, one off: the switches say so by aria-checked, in the order the page lists them.
    const row = (id: string) => html.match(new RegExp(`<button[^>]*data-setting-id="${id.replace(/\./g, "\\.")}"[^>]*>`))?.[0].match(/aria-checked="(true|false)"/)?.[1];
    expect(["move", "comment", "link", "assign"].map((k) => row(`jira.writes.${k}`))).toEqual(["true", "false", "true", "true"]);
  });

  test("it has the cards the plan names, and no per-project hand-off card", () => {
    const html = view();
    for (const t of ["Changes in Jira", "What we found", "Workflow map", "Where this shows up", "Advanced", "Saved views and folders", "Write permissions", "Disconnect"]) expect(html).toContain(t);
    expect(html).not.toContain("QA hand-off");
  });

  test("the map shows the projects that count with their statuses, and folds the ignored one", () => {
    const html = view();
    expect(html).toContain("Orbit core");
    expect(html).toContain("Orbit docs");
    expect(html).toContain("Peer check");
    expect(html).toContain("2 projects count");
    expect(html).toContain("1 ignored");
    expect(html).toContain("Orbit ops");
  });

  test("the steps on the site are the steps on the map, in map order, and a link block is one of them", () => {
    const html = view();
    expect(html).toContain("Button on a pull request");
    expect(html).toContain("Option in the merge dialog");
    expect(html).not.toContain("Item in the review menu");
    expect(html).toContain("Link the pull request on the card");
  });

  test("the review step is called what it is on a Jira card: a button, not an item in a menu", () => {
    const html = view({ steps: { ...STEPS, review: { enabled: true, blocks: [{ type: "move", statusNames: ["Peer check"] }] } } });
    expect(html).toContain("Review button on a pull request");
    expect(html).not.toContain("Item in the review menu");
    expect(html).not.toContain("Review menu");
  });

  test("a step's status is covered where the site has it, and the page says where it is missing", () => {
    const spaces = asSpaces(UNITS);
    expect(coverage(spaces, "Peer check").all).toBe(true);
    expect(coverage(spaces, "Shipped")).toMatchObject({ has: ["Orbit core"], missing: ["Orbit docs"], all: false });
    expect(view()).toContain("Orbit core only");
  });

  test("writes off says read-only; writes on says the steps can act", () => {
    expect(view({ writes: false })).toContain("agentglass only reads");
    const on = view({ writes: true });
    expect(on).toContain("Only the steps below can change a card");
    expect(on).toContain("data-guard=\"on\"");
  });

  test("no steps: the map is empty and offers Add a step; nothing is added for the person", () => {
    const html = view({ steps: { handoff: off, review: off, merge: off } });
    expect(html).toContain("Add a step");
    expect(html).not.toContain("data-press=");
  });

  test("a read that failed keeps the last good answer and says it is old", () => {
    const html = view({ units: { kind: "error", error: "Jira did not answer", throttled: false, stale: UNITS, staleAt: Date.now() - 5 * 60_000 } });
    expect(html).toContain("Orbit core");
    expect(html).toContain("5 min ago");
  });

  test("projects whose older hand-off rule still wins are named, and each can be cleared", () => {
    const html = view({ overrides: ["DOCS"] });
    expect(html).toContain("Use the hand-off step for DOCS");
    expect(view()).toContain("None: the hand-off step applies to every project.");
  });

  test("while the steps are being read there is a sentence, not a flash of an empty map", () => {
    expect(view({ steps: null })).toContain("Reading your settings");
  });
});

describe("Jira's steps as the map reads them", () => {
  test("kinds are the three places and no reviewer list or note, which are ClickUp's own", () => {
    expect(JIRA.kinds).toEqual(["move", "menu", "merge"]);
    expect(jiraSteps(STEPS).map((s) => s.kind)).toEqual(["move", "merge"]);
    expect(jiraSteps(STEPS)[0]).toMatchObject({ status: "Peer check", implicit: false });
  });

  test("adding, editing and removing send the patch the server's save takes, by place", () => {
    expect(jiraAdd("menu")).toEqual({ review: { enabled: true, blocks: [] } });
    expect(jiraBlocks("move", [{ type: "link" }])).toEqual({ handoff: { blocks: [{ type: "link" }] } });
    expect(jiraRemove("merge")).toEqual({ merge: { enabled: false, blocks: [] } });
    expect(jiraAdd("people")).toEqual({});
    // A name every object has is not a place a step can be.
    expect(jiraAdd("toString" as never)).toEqual({});
    expect(jiraRemove("constructor" as never)).toEqual({});
  });

  test("the sample status is the person's own: every status the page names comes from the data handed in", () => {
    const names = allStatuses(asSpaces(UNITS)).map((s) => s.name);
    expect(names).toContain("Queued");
    expect(JIRA.sample.status).toBe("");
  });
});

describe("the page's source names no status", () => {
  const SOURCES = ["src/components/jira/JiraSettingsView.tsx", "src/components/JiraPane.tsx", "src/lib/jiraWorkflow.ts", "src/lib/jiraUnits.ts"];
  const STATUSES = ["To Do", "In Progress", "In Review", "Done", "QA", "Backlog", "Ready for QA", "Code Review", "Closed", "Open", "Resolved", "Selected for Development"];
  test("none of the common Jira status names, nor the fixture's, is written in it", async () => {
    for (const f of SOURCES) {
      const src = (await Bun.file(new URL(`../${f}`, import.meta.url)).text()).split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
      for (const name of [...STATUSES, ...UNITS.flatMap((u) => u.statuses.map((s) => s.status))]) {
        expect(src.includes(`"${name}"`), `${f} writes the status "${name}"`).toBe(false);
      }
    }
  });
});

describe("the page is in the settings index", () => {
  const rows = SETTINGS_ROWS.filter((r) => r.pane === "jira");
  test("its rows are found, though a view two components down draws them, so search and the palette can jump to them", () => {
    expect(rows.map((r) => r.label)).toContain("Disconnect Jira");
    expect(rows.length).toBeGreaterThanOrEqual(8);
  });
  // The registry reads the window's storage when it loads, so it is loaded under a stub that goes back when the file ends.
  let reg: typeof import("../src/lib/settingsRegistry.ts");
  beforeAll(async () => {
    reg = await import("../src/lib/settingsRegistry.ts");
  });
  test("the settings on it are defs an agent can read, bound to its row; the connection and the switch are not", () => {
    expect(rows.find((r) => r.settingId === "jira.statusUnits.counted")?.label).toBe("Projects that count");
    expect(reg.SETTING_DEFS.filter((d) => d.page === "jira").map((d) => d.id)).toEqual(["jira.statusUnits.counted", "jira.tree.shapes"]);
    expect(reg.isMigrated("jira", "")).toBe(true);
  });
});

describe("the map has the room it needs", () => {
  test("Jira's page is as wide as ClickUp's, or the statuses fall under the steps and no line is drawn to them", async () => {
    const modal = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();
    const wide = modal.slice(modal.indexOf("const WIDE_PANES"), modal.indexOf("]);", modal.indexOf("const WIDE_PANES")));
    expect(wide).toContain('["jira", "1900px"]');
    expect(wide).toContain('["clickup", "1900px"]');
  });
});
