/*
 * The Jira sidebar, round 3: "Sync with Jira filters", the team rows that filter the board, and the local saved-query
 * calls. The screens have no renderer here: the decisions are tested in lib/, the wiring is read as source, and the
 * server half (routes, counts, local-only edits) is server/test/jira-sidebar-r3-routes.test.ts.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import { assigneeCountId, assigneeSearch, sectionRows, starredAt, starredViews, teamOf, viewMenu, type TreeRow, type TreeView } from "../src/lib/jiraTree.ts";
import { readable } from "../src/lib/personNames.ts";

const read = async (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const treeSrc = await read("../src/components/jira/JiraTree.tsx");
const panelSrc = await read("../src/components/TasksPanel.tsx");
const apiSrc = await read("../src/lib/api.ts");
const cssSrc = await read("../src/index.css");

const stubGlobal = globalStubs();
const mem = new Map<string, string>();
stubGlobal("window", new EventTarget());
stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, String(v)); }, removeItem: (k: string) => { mem.delete(k); },
});

const view = (id: string, label: string, kind: TreeView["kind"], team?: boolean): TreeRow => ({ key: `v:${id}`, kind: "view", level: 0, view: { id, label, kind, ...(team ? { team: true } : null) } });
const favSrc = await read("../src/lib/jiraFavourites.ts");
const countsSrc = await read("../src/lib/useJiraViewCounts.ts");
const jumpSrc = await read("../src/components/jira/JiraJump.tsx");

describe("Sync with Jira filters", () => {
  test("a favourite becomes a saved query linked by its filter id, once: one saved already is skipped", () => {
    expect(favSrc).toContain("if (have.has(`filter:${f.id}`)) continue;");
    expect(favSrc).toContain("(await save(f.id)).ok");
  });
  test("an empty answer adds nothing and says so; a failure keeps the switch and says so", () => {
    expect(favSrc).toContain('export const NO_FAVOURITES = "No Jira favourites"');
    expect(favSrc).toContain('export const FAVOURITES_FAILED = "Could not read Jira filters"');
    expect(favSrc).toContain("if (r.filters.length === 0) { setNote(NO_FAVOURITES); return; }");
    expect(favSrc).toContain("if (!r.ok || !r.filters) { setNote(FAVOURITES_FAILED); return; }");
    expect(favSrc).not.toContain("setSyncFavourites(false)");
  });
  let P: typeof import("../src/lib/jiraFavourites.ts");
  beforeAll(async () => { P = await import("../src/lib/jiraFavourites.ts"); });
  test("the window setting defaults to on, is stored only when changed, and tells its listeners", () => {
    expect(P.syncFavouritesNow()).toBe(true);
    P.setSyncFavourites(false);
    expect(P.syncFavouritesNow()).toBe(false);
    expect(mem.get("agentglass.jira.syncFavourites")).toBe("0");
    P.setSyncFavourites(true);
    expect(P.syncFavouritesNow()).toBe(true);
    expect(mem.has("agentglass.jira.syncFavourites")).toBe(false);
  });
  test("it is a registered LOW window setting an agent can read", async () => {
    const reg = await import("../src/lib/settingsRegistry.ts");
    const d = reg.SETTING_DEFS.find((x) => x.id === "jira.syncFavourites")!;
    expect(d).toMatchObject({ page: "jira", default: true, label: "Sync with Jira filters" });
    expect(d.validate(false)).toBe(false);
    expect(d.validate("no")).toBeNull();
    const cls = await import("../../shared/settingClass.ts");
    expect(cls.classOf("jira.syncFavourites")?.class).toBe("low");
  });
  test("the panel imports only while the setting is on; the switch is in Settings > Jira, not a sidebar row", () => {
    expect(panelSrc).toContain("useFavouriteImport(isJira && active && jiraSync");
    expect(treeSrc).not.toContain("agx-jsb-sync");
    expect(cssSrc).not.toContain(".agx-jsb-sync");
  });
  test("the quiet line sits under the switch and the sidebar gets it from the panel", () => {
    expect(panelSrc).toContain("note: jiraFilterSync.note");
    expect(treeSrc).toContain('className="agx-jsb-note"');
  });
});

describe("Starred filters, Team and g then a digit", () => {
  test("a view saved with the team scope lists under Team; the others stay under Starred filters", () => {
    const sec = sectionRows([view("jql:a", "My open bugs", "jql"), view("jql:b", "Blocked", "jql", true), view("filter:10020", "Orbit bugs", "filter", true)]);
    expect(sec.views.map((r) => r.key)).toEqual(["v:jql:a"]);
    expect(sec.team.map((r) => r.key)).toEqual(["v:jql:b", "v:filter:10020"]);
  });
  test("g then 1-9 follows the sidebar order: Starred filters first, then Team; the 10th has no key", () => {
    const rows = [...Array.from({ length: 4 }, (_, i) => view(`jql:${i}`, `S${i}`, "jql")), ...Array.from({ length: 7 }, (_, i) => view(`jql:t${i}`, `T${i}`, "jql", true))];
    const sec = sectionRows(rows);
    const order = [...sec.views, ...sec.team];
    expect(starredAt(order, "5")).toBe(sec.team[0]);
    expect(starredAt(order, "9")).toBe(sec.team[4]);
    expect(order.length).toBe(11);
    expect(starredAt(order, "0")).toBeNull();
    expect(treeSrc).toContain("const goable = [...sec.views, ...sec.team];");
  });
  test("no label shows a raw account id: a person filter reads as the name or as \"Person filter\"", () => {
    const raw = 'assignee = "712020:5b10ac8d-82e0-4a41-9c1f-0123456789ab"';
    for (const out of [readable(raw), readable(raw, () => undefined), readable('reporter = 5b10ac8d82e04a419c1f0123')]) {
      expect(out).toBe("Person filter");
      expect(out).not.toMatch(/\d+:[0-9a-f-]{8,}/);
      expect(out).not.toMatch(/\b[0-9a-f]{24}\b/);
    }
    expect(readable(raw, () => "Mira R.")).toBe('assignee = "Mira R."');
    expect(panelSrc).toContain("label: tidyPerson(");
  });
  test("a team row is a saved query row: counted like the others, with no roster of project members", () => {
    expect(panelSrc).not.toContain("teamOf(");
    expect(panelSrc).toContain("useJiraViewCounts(jiraStarred.map((v) => v.id), isJira && active)");
  });
});

describe("the Jira badge and the filter menu", () => {
  test("a linked filter row has the badge; a search saved here does not", () => {
    expect(treeSrc).toContain('r.view.kind === "filter" && <span className="agx-jsb-tag');
  });
  test("a filter's menu has Sync from and Sync to; a search or a board does not; rename is only in the menu", () => {
    const ids = (k: TreeView["kind"]) => JSON.stringify(viewMenu({ id: "x", label: "L", kind: k }, { hidden: 0, site: true, pinned: false }));
    expect(ids("filter")).toContain('"syncfrom"');
    expect(ids("filter")).toContain('"syncto"');
    expect(ids("jql")).not.toContain("syncto");
    expect(ids("board")).not.toContain("syncfrom");
    expect(treeSrc).not.toContain("onDoubleClick");
  });
  test("Sync to Jira filter asks first, naming the change, and only Replace calls the write", () => {
    expect(treeSrc).toContain('case "syncto": if (r.kind === "view") setConfirmTo({ id: r.view.id, label: r.view.label }); break;');
    expect(treeSrc).toContain("onClick={() => { out.onSyncTo?.(confirmTo.id); setConfirmTo(null); }}");
    expect(treeSrc).toContain("Replace the search of “{confirmTo.label}” in Jira with the one in the box?");
  });
});

describe("the saved-query calls the board's menus code against", () => {
  test("the four signatures and their routes", () => {
    expect(apiSrc).toContain("jiraFavourites: (signal?: AbortSignal) => get<{ ok: boolean; filters?: { id: string; name: string; jql: string }[]; error?: string }>(\"/jira/favourites\", signal)");
    expect(apiSrc).toContain("jiraEditView: (id: string, patch: { name?: string; team?: boolean; tab?: boolean; jql?: string }) =>");
    expect(apiSrc).toContain('"/jira/views/edit", { id, ...patch }');
    expect(apiSrc).toContain('jiraDuplicateView: (id: string) => post<{ ok: boolean; error?: string; view?: SavedView }>("/jira/views/duplicate", { id })');
    expect(apiSrc).toContain("jiraSaveJql: (jql: string, name?: string) => post<{ ok: boolean; error?: string; view?: SavedView }>(\"/jira/views/save-jql\"");
  });
  test("the filter sync calls post to one route and have demo stubs", () => {
    expect(apiSrc).toContain('post<{ ok: boolean; error?: string; filter?: { id: string; name: string; jql: string } }>("/jira/filter", { id, jql })');
    expect(apiSrc).toMatch(/  jiraFilter: \(_id: string\)[^\n]*D\(\{ ok: false, error: "not available in the demo" \}\)/);
    expect(apiSrc).toMatch(/  jiraWriteFilter: \(_id: string, _jql: string\)[^\n]*D\(\{ ok: false, error: "not available in the demo" \}\)/);
  });
  test("each has a demo stub that says it is not available", () => {
    for (const n of ["jiraFavourites", "jiraEditView", "jiraDuplicateView", "jiraSaveJql"]) {
      expect(apiSrc).toMatch(new RegExp(`  ${n}: \\(_[^\\n]*D\\(\\{ ok: false, error: "not available in the demo" \\}\\)`));
    }
  });
});

describe("loading states: a dim last count or a dash, never a moving spinner", () => {
  test("a count read again, or whose read failed, keeps the last number the site gave, marked stale", () => {
    expect(countsSrc).toContain("const staleOr = (id: string): ViewCount => { const l = last.get(id); return l ? { ...l, stale: true } : \"err\"; };");
    expect(countsSrc).toContain("[id]: got ?? staleOr(id)");
    expect(countsSrc).toContain("if (got) last.set(id, got);");
  });
  test("the sidebar dims a stale count and has nothing that spins in the count column", () => {
    expect(treeSrc).toContain('c.stale ? "stale"');
    expect(cssSrc).toContain('.agx-jsb-count[data-count="stale"] { color: var(--text4); opacity: 0.6; }');
    const block = cssSrc.slice(cssSrc.indexOf(".agx-jsb-count {"), cssSrc.indexOf('.agx-jsb-count[data-count="stale"]') + 120);
    expect(block).not.toMatch(/animation|spin/);
  });
  test("the palette says Searching Jira... only for a JQL count, a key lookup or the words search, and nowhere else", () => {
    expect(jumpSrc.match(/Searching Jira\.\.\./g)?.length).toBe(4);
    expect(jumpSrc).toContain('jqlCount.err ? "—" : "Searching Jira..."');
    expect(jumpSrc).toContain('looking === it.key ? "Searching Jira..."');
    expect(jumpSrc).toContain("!items.length && nothingLocal && !(site && site.q === words)");
  });
});
