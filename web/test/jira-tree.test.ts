/*
 * The Jira sidebar tree: the rules that decide which rows exist, which menu
 * says what, and what an address turns into. The screens have no renderer
 * here, so the decisions live in lib/jiraTree.ts and are tested there.
 */
import { describe, expect, test } from "bun:test";
import type { JiraSpace, JiraSpaceTree, JiraTreeComponent, JiraTreeEpic } from "../../shared/jiraSpaces.ts";
import {
  EMPTY_PREFS, EPICS_PER_COMPONENT, browseUrl, buildRows, componentMenu, componentUrl, epicMenu, epicProgress,
  keyC, keyE, keyS, meMenu, parsePrefs, epicTip, spaceMenu, viewMenu, type TreeInput, type TreeRow,
} from "../src/lib/jiraTree.ts";
import { parseAddress } from "../src/lib/jiraAddress.ts";
import { walkIds } from "../src/lib/prCardMenu.ts";

const epic = (n: number, comps: string[] = ["Ingest"], cat: "open" | "done" = "open"): JiraTreeEpic =>
  ({ key: `ORB-${n}`, id: String(n), summary: `Vector index fold ${n}`, status: { name: cat === "done" ? "Done" : "In Progress", category: cat }, done: 1, total: 4, components: comps });
const comp = (name: string, epics: JiraTreeEpic[], o: Partial<JiraTreeComponent> = {}): JiraTreeComponent =>
  ({ id: name, name, issues: epics.length * 4, empty: false, noEpic: 0, epics, ...o });
const tree = (components: JiraTreeComponent[]): JiraSpaceTree =>
  ({ space: "ORB", noEpic: 0, components, total: 10, done: 2, hidDone: 0, readAt: 1 });
const orbit: JiraSpace = { key: "ORB", name: "Orbit" };
const ops: JiraSpace = { key: "OPS", name: "Operations" };
const input = (o: Partial<TreeInput> & { t?: JiraSpaceTree }): TreeInput => ({
  spaces: [orbit], reads: { ORB: { state: "ready", tree: o.t ?? tree([]) } }, prefs: EMPTY_PREFS, q: "", views: [], looked: 0, listed: true, ...o,
});
const kinds = (rows: TreeRow[]): string[] => rows.map((r) => r.kind);
const many = (n: number): JiraTreeEpic[] => Array.from({ length: n }, (_, i) => epic(i + 1));

describe("buildRows: what is open and how much is drawn", () => {
  const t = tree([comp("Ingest", many(14), { noEpic: 3 }), comp("Search", many(2).map((e) => ({ ...e, key: `S-${e.key}` })))]);

  test("the first space opens, and in it the first component with something", () => {
    const rows = buildRows(input({ t }));
    expect(rows.filter((r) => r.kind === "component" && r.open).map((r) => (r as { name: string }).name)).toEqual(["Ingest"]);
  });

  test("a component shows six epics, then says how many are left", () => {
    const rows = buildRows(input({ t }));
    expect(EPICS_PER_COMPONENT).toBe(6);
    expect(rows.filter((r) => r.kind === "epic").length).toBe(6);
    const more = rows.find((r) => r.kind === "more") as { n: number };
    expect(more.n).toBe(8);
    expect(rows.some((r) => r.kind === "noepic")).toBe(true);
  });

  test("asking for all of them draws all of them and drops the row", () => {
    const rows = buildRows(input({ t, prefs: { ...EMPTY_PREFS, all: { [keyC("ORB", "Ingest")]: true } } }));
    expect(rows.filter((r) => r.kind === "epic").length).toBe(14);
    expect(rows.some((r) => r.kind === "more")).toBe(false);
  });

  test("the filter opens everything, finds epics past the cap and drops the cap", () => {
    const rows = buildRows(input({ t, q: "fold 14" }));
    expect(rows.filter((r) => r.kind === "epic").map((r) => (r as { epic: JiraTreeEpic }).epic.key)).toEqual(["ORB-14"]);
    expect(rows.some((r) => r.kind === "more")).toBe(false);
  });

  test("the filter opens a space and a component the person had folded", () => {
    const folded = { ...EMPTY_PREFS, open: { [keyS("ORB")]: false, [keyC("ORB", "Ingest")]: false } };
    expect(buildRows(input({ t, prefs: folded })).some((r) => r.kind === "epic")).toBe(false);
    expect(buildRows(input({ t, prefs: folded, q: "fold 14" })).some((r) => r.kind === "epic")).toBe(true);
  });

  test("an empty component is kept, dim, and goes when empties are hidden", () => {
    const withEmpty = tree([comp("Ingest", many(1)), comp("Auth", [], { empty: true, issues: 0 })]);
    const shown = buildRows(input({ t: withEmpty }));
    expect((shown.find((r) => r.kind === "component" && r.name === "Auth") as { empty: boolean }).empty).toBe(true);
    const hid = buildRows(input({ t: withEmpty, prefs: { ...EMPTY_PREFS, hideEmpty: { ORB: true } } }));
    expect(hid.some((r) => r.kind === "component" && r.name === "Auth")).toBe(false);
  });

  test("an epic in two components is marked shared and names the other", () => {
    const shared = tree([comp("Ingest", [epic(1, ["Ingest", "Search"])]), comp("Search", [epic(1, ["Ingest", "Search"])])]);
    const rows = buildRows(input({ t: shared, prefs: { ...EMPTY_PREFS, open: { [keyC("ORB", "Search")]: true } } }));
    const e = rows.find((r) => r.kind === "epic") as { shared: boolean; also: string[] };
    expect(e.shared).toBe(true);
    expect(e.also).toEqual(["Search"]);
  });

  test("a done epic is dimmed, a hidden one is gone, a pinned one comes first", () => {
    const t3 = tree([comp("Ingest", [epic(1), epic(2, ["Ingest"], "done"), epic(3)])]);
    const rows = buildRows(input({ t: t3, prefs: { ...EMPTY_PREFS, hidden: { [keyE("ORB", "Ingest", "ORB-1")]: true }, pinned: { [keyE("ORB", "Ingest", "ORB-3")]: true } } }));
    const eps = rows.filter((r) => r.kind === "epic") as { epic: JiraTreeEpic; dim: boolean }[];
    expect(eps.map((e) => e.epic.key)).toEqual(["ORB-3", "ORB-2"]);
    expect(eps[1]!.dim).toBe(true);
  });

  test("a space that failed to read says so and keeps its last tree out of the way", () => {
    const rows = buildRows(input({ spaces: [orbit, ops], reads: { ORB: { state: "ready", tree: t }, OPS: { state: "error", error: "Jira did not answer" } } }));
    const row = rows.find((r) => r.kind === "space" && r.space.key === "OPS") as { error?: string };
    expect(row.error).toBe("Jira did not answer");
  });

  test("a space that is loading draws a skeleton and nothing else under it", () => {
    const rows = buildRows(input({ reads: { ORB: { state: "loading" } } }));
    expect(kinds(rows)).toContain("skeleton");
    expect(kinds(rows)).not.toContain("component");
  });

  test("a space with no components says it has no epics", () => {
    const rows = buildRows(input({ t: tree([]) }));
    expect(rows.some((r) => r.kind === "note")).toBe(true);
  });
});

describe("parsePrefs", () => {
  test("anything that is not an object is the empty prefs", () => {
    for (const raw of [null, "", "{", "[]", "3", "null"]) expect(parsePrefs(raw)).toEqual(EMPTY_PREFS);
  });
  test("a saved selection and the last space survive a round trip", () => {
    const p = parsePrefs(JSON.stringify({ sel: { ORB: { kind: "epic", component: "Ingest", epic: "ORB-9" } }, last: "ORB", hideMe: true }));
    expect(p.last).toBe("ORB");
    expect(p.sel.ORB).toEqual({ kind: "epic", component: "Ingest", epic: "ORB-9" });
    expect(p.hideMe).toBe(true);
  });
  test("keys are one string per thing", () => {
    expect(keyS("ORB")).toBe("s:ORB");
    expect(keyC("ORB", undefined)).toBe("c:ORB/");
  });
});

describe("epic progress", () => {
  test("no cards is a dotted zero, not a division", () => {
    expect(epicProgress({ done: 0, total: 0 })).toMatchObject({ pct: 0, zero: true });
  });
  test("done over total, rounded", () => {
    expect(epicProgress({ done: 5, total: 12 }).text).toBe("5/12");
  });
});

describe("menus", () => {
  const facts = { hidden: 0, site: true, pinned: false };
  const ids = (m: Parameters<typeof walkIds>[0]) => walkIds(m, false);

  test("only a space and a view can be taken off the bar", () => {
    expect(spaceMenu(orbit, facts).closeAbsent).toBe(false);
    expect(viewMenu({ id: "1", label: "Open bugs", kind: "filter" }, facts).closeAbsent).toBe(false);
    expect(componentMenu("ORB", { name: "Ingest", issues: 3, empty: false }, { ...facts, empties: [], none: false }).closeAbsent).toBe(true);
    expect(epicMenu(epic(9), "Ingest", [], facts).closeAbsent).toBe(true);
    expect(meMenu(4).closeAbsent).toBe(true);
  });

  test("a row that cannot run says why instead of vanishing", () => {
    const m = spaceMenu(orbit, { ...facts, site: false });
    const jira = m.rows.find((r) => r.kind === "item" && r.id === "jira") as { why?: string };
    expect(jira.why).toBe("No site connected");
  });

  test("an empty component offers to hide the empties, not to collapse", () => {
    const m = componentMenu("ORB", { name: "Auth", issues: 0, empty: true }, { ...facts, empties: ["Auth", "Data"], none: false });
    expect(ids(m)).toContain("hideempty");
    expect(ids(m)).not.toContain("collapse");
  });

  test("the No component group cannot be hidden", () => {
    const m = componentMenu("ORB", { name: "No component", issues: 5, empty: false }, { ...facts, empties: [], none: true });
    expect(ids(m)).not.toContain("hide");
  });

  test("a shared epic offers to show it under the other component", () => {
    expect(ids(epicMenu(epic(9, ["Ingest", "Search"]), "Ingest", ["Search"], facts))).toContain("under");
    expect(ids(epicMenu(epic(9), "Ingest", [], facts))).not.toContain("under");
  });

  test("what was hidden can be brought back from the space menu", () => {
    expect(ids(spaceMenu(orbit, { ...facts, hidden: 2 }))).toContain("showhidden");
    expect(ids(spaceMenu(orbit, facts))).not.toContain("showhidden");
  });
});

describe("addresses", () => {
  test("a search with a project offers the search first and the project second", () => {
    const p = parseAddress("https://acme.example.net/issues/?jql=project%20%3D%20ORB%20AND%20status%20%3D%20Open%20ORDER%20BY%20created");
    expect(p.choices.map((c) => c.kind)).toEqual(["jql", "space"]);
    expect(p.choices[1]!.id).toBe("ORB");
    expect(p.jql).toBe("project = ORB AND status = Open");
  });
  test("a project page is a space", () => {
    expect(parseAddress("https://acme.example.net/jira/software/projects/ORB/boards/1").choices).toEqual([]);
    expect(parseAddress("https://acme.example.net/jira/software/projects/ORB/summary").choices[0]).toMatchObject({ kind: "space", id: "ORB" });
  });
  test("a javascript: or file: address is nothing", () => {
    expect(parseAddress("javascript:alert(1)//projects/ORB/summary").choices).toEqual([]);
    expect(parseAddress("file:///etc/passwd").choices).toEqual([]);
    expect(parseAddress("not an address").choices).toEqual([]);
  });
});

describe("links", () => {
  test("a key is encoded, a site without a scheme gets one", () => {
    expect(browseUrl("acme.example.net", "ORB-9")).toBe("https://acme.example.net/browse/ORB-9");
    expect(componentUrl("acme.example.net", "ORB", "Billing API")).toContain("Billing%20API");
  });
});

const treeSource = await Bun.file(new URL("../src/components/jira/JiraTree.tsx", import.meta.url)).text();

describe("an epic row says who holds it", () => {
  test("the row tip carries summary, key, status, people, progress and components", () => {
    const e = { ...epic(1, ["Ingest"]), assignee: { key: "a", id: "a", name: "Lin Tester" }, reporter: { key: "b", id: "b", name: "Sam Rivera" } };
    expect(epicTip(e, [])).toEqual({
      name: "Vector index fold 1", detail: "ORB-1", tag: "In Progress",
      rows: [{ k: "Assignee", v: "Lin Tester" }, { k: "Reporter", v: "Sam Rivera" }, { k: "Progress", v: "1 of 4 cards done" }, { k: "Components", v: "Ingest" }],
    });
  });

  test("unassigned says so, the reporter is still named, and no components means no row", () => {
    const t = epicTip({ ...epic(2, []), total: 0, done: 0, reporter: { key: "b", id: "b", name: "Sam Rivera" } }, []);
    expect(t.rows).toEqual([{ k: "Assignee", v: "Unassigned" }, { k: "Reporter", v: "Sam Rivera" }, { k: "Progress", v: "No cards" }]);
  });

  test("the row draws one face (the assignee's) with the house tip, never a native title, and keeps the summary ellipsized", () => {
    const at = treeSource.indexOf('case "epic": {');
    const body = treeSource.slice(at, treeSource.indexOf('case "noepic":', at));
    expect(body).toContain('data-epic-person="assignee"');
    expect(body).toContain("h: EPIC_H, tip,");
    expect(body).not.toContain("data-tip=");
    expect(body).not.toContain("data-epic-person=\"reporter\"");
    expect(body).not.toMatch(/\btitle=/);
    expect(body).toContain('className="truncate"');
    expect(body).toContain("EPIC_H");
  });
});
