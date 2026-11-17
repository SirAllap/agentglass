/*
 * The Jira sidebar's sections (starred views with counts, team, me, spaces, More). The screens have no renderer here:
 * the decisions are tested in lib/jiraTree.ts and the wiring is read as source.
 */
import { describe, expect, test } from "bun:test";
import type { JiraSpace, JiraSpaceTree } from "../../shared/jiraSpaces.ts";
import {
  EMPTY_PREFS, buildRows, countLabel, sectionRows, spaceProgress, starredAt, type TreeInput, type TreeRow, type TreeView,
} from "../src/lib/jiraTree.ts";

const read = async (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const treeSrc = await read("../src/components/jira/JiraTree.tsx");
const railSrc = await read("../src/components/jira/JiraFoldedRail.tsx");
const panelSrc = await read("../src/components/TasksPanel.tsx");
const hookSrc = await read("../src/lib/useJiraViewCounts.ts");
const cssSrc = await read("../src/index.css");

const orbit: JiraSpace = { key: "ORB", name: "Orbit" };
const tree: JiraSpaceTree = { space: "ORB", noEpic: 0, components: [], total: 10, done: 4, hidDone: 0, readAt: 1 };
const views: TreeView[] = [
  { id: "board:1", label: "Orbit board", kind: "board", spaceKey: "ORB" },
  { id: "filter:7", label: "Needs review", kind: "filter" },
  { id: "jql:a", label: "Mine open", kind: "jql" },
];
const input = (o: Partial<TreeInput> = {}): TreeInput => ({
  spaces: [orbit], reads: { ORB: { state: "ready", tree } }, prefs: EMPTY_PREFS, q: "", views, looked: 2, sprint: "Sprint 14", listed: true, meCount: 3, ...o,
});

describe("the count column", () => {
  test("a dash while loading or on error", () => {
    expect(countLabel(undefined)).toBe("—");
    expect(countLabel("err")).toBe("—");
  });
  test("N when exact, N+ when the server stopped at its page", () => {
    expect(countLabel({ n: 12, more: false })).toBe("12");
    expect(countLabel({ n: 100, more: true })).toBe("100+");
    expect(countLabel({ n: 0, more: false })).toBe("0");
  });
  test("one request per view, no polling timer (only the bounded not-read-yet backoff), and a failure is a dash", () => {
    expect(hookSrc).toContain("api.jiraViewCount(id");
    expect(hookSrc).toContain("asked.current.has(id)");
    expect(hookSrc).not.toMatch(/setInterval/);
    expect(hookSrc.match(/setTimeout\(/g)?.length).toBe(1);
    expect(hookSrc).toContain("const wait = countRetryMs(n);");
    expect(hookSrc).toContain('"err"');
  });
  test("the sidebar and the folded rail both read the same counts", () => {
    expect(panelSrc).toContain("useJiraViewCounts(");
    expect(panelSrc).toContain("counts: jiraViewCounts");
    expect(panelSrc).toContain("counts={jiraViewCounts}");
    expect(treeSrc).toContain("countLabel(c)");
    expect(railSrc).toContain("countLabel(count)");
  });
});

describe("g then a digit", () => {
  test("picks the Nth row and nothing past the end", () => {
    const rows = ["a", "b", "c"];
    expect(starredAt(rows, "1")).toBe("a");
    expect(starredAt(rows, "3")).toBe("c");
    expect(starredAt(rows, "4")).toBeNull();
    expect(starredAt(rows, "0")).toBeNull();
    expect(starredAt(rows, "x")).toBeNull();
  });
  test("is ignored while typing, with a modifier, or when the g went stale", () => {
    // The rule itself lives in gotoStep, tested as behaviour in jira-review-fixes.test.ts.
    expect(treeSrc).toContain("gotoStep(e, goto.current.at, Date.now(), jiraViewActiveNow())");
  });
});

describe("sectionRows: no old row kind is lost", () => {
  const rows = buildRows(input());
  const sec = sectionRows(rows);
  const all = [...sec.views, ...sec.me, ...sec.spaces, ...sec.more];
  test("every row is kept once, except the captions the sections replace", () => {
    const dropped = rows.filter((r) => !all.includes(r)).map((r) => r.key).sort();
    expect(dropped).toEqual(["cap:spaces", "cap:views", "capv:ORB"]);
    expect(new Set(all.map((r) => r.key)).size).toBe(all.length);
  });
  test("views, me, spaces and sprint / Looked up land in their own section", () => {
    expect(sec.views.map((r) => r.kind)).toEqual(["view", "view", "view"]);
    expect(sec.me.map((r) => r.kind)).toEqual(["me"]);
    expect(sec.spaces.some((r) => r.kind === "space")).toBe(true);
    expect(sec.more.map((r) => r.kind)).toEqual(["caption", "sprint", "caption", "looked"]);
  });
  test("every kind the tree draws still has a case in the sidebar", () => {
    const kinds: TreeRow["kind"][] = ["caption", "me", "looked", "sprint", "space", "components", "component", "epic", "noepic", "more", "note", "skeleton", "view"];
    for (const k of kinds) expect(treeSrc).toContain(`case "${k}"`);
  });
  test("the add flows, the menu and the legacy rows stay reachable", () => {
    expect(treeSrc).toContain("{out.legacy}");
    expect(treeSrc).toContain("<PrCardMenu");
    expect(treeSrc).toContain('label="More"');
    expect(panelSrc).toContain("<AddSpacePopover");
  });
});

describe("team and spaces", () => {
  test("a space ring needs a read; without one it is empty", () => {
    expect(spaceProgress(undefined)).toBeNull();
    expect(spaceProgress({ state: "loading" })).toBeNull();
    expect(spaceProgress({ state: "ready", tree })).toEqual({ done: 4, total: 10, components: 0 });
  });
  test("the second line is KEY, done over total, then the component count", () => {
    expect(treeSrc).toContain("[r.space.key, pg && pg.total");
    expect(treeSrc).toContain('`Spaces · ${site}`');
  });
});

describe("the sidebar at a narrow width", () => {
  test("an epic row's key and count never break mid-word or wrap over the bar", () => {
    // The key and the count share one line under the name, and that line truncates with an ellipsis: it never
    // wraps or breaks mid-word, and the row's height stays the epic row's.
    expect(treeSrc).toContain('<span className="truncate min-w-0" style={{ fontSize: 10.5, color: "var(--text3)", lineHeight: 1.3 }}>');
    expect(treeSrc).toContain('<span className="tabular-nums">{r.epic.key} · {pr.text}</span>');
  });
  test("View by's label and toggles wrap as a whole, never break mid-word", () => {
    expect(treeSrc).toContain('className="flex flex-wrap items-center" style={{ minHeight: 22, gap: 6, marginTop: 8,');
    expect(treeSrc).toContain('<span className="shrink-0 whitespace-nowrap" style={{ letterSpacing: 0, textTransform: "none" }}>View by</span>');
    expect(treeSrc).toContain('<div role="radiogroup" aria-label="View this space by" className="shrink-0 flex items-center"');
  });
});

describe("the sidebar styles", () => {
  const block = cssSrc.slice(cssSrc.indexOf("/* jira sidebar sections */"));
  test("one block at the end of the sheet, tokens only", () => {
    expect(block.length).toBeGreaterThan(40);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
