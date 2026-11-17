/*
 * The "Applies to" dropdown: one button saying the current choice, a menu of
 * "All projects", a divider, then every project (check on the current one,
 * search only past SEARCH_FROM), and the list it reads is the same scanned set
 * the Open projects dialog lists, not the registered repos alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/lib/api.ts";
import { ScopeControl } from "../src/components/settings/scope/ScopeControl.tsx";
import { SEARCH_FROM, menuRows, projectList, triggerLabel, typeAhead } from "../src/components/settings/scope/scopeModel.ts";
import { resetScannedRepos, scannedReposOnce } from "../src/components/settings/scope/useScope.ts";

const three = ["/code/orbit", "/code/acme", "/code/zephyr"];

describe("menu model", () => {
  test("All projects first, a divider, then the projects in list order", () => {
    expect(menuRows(three, "/code/orbit", "all").map((r) => r.kind)).toEqual(["all", "divider", "project", "project", "project"]);
    expect(menuRows(three, "/code/orbit", "all").flatMap((r) => (r.kind === "project" ? [r.name] : []))).toEqual(["orbit", "acme", "zephyr"]);
  });
  test("one check, on the current choice", () => {
    const checked = (rows: ReturnType<typeof menuRows>) => rows.filter((r) => "checked" in r && r.checked).map((r) => (r.kind === "project" ? r.root : r.kind));
    expect(checked(menuRows(three, "/code/acme", "all"))).toEqual(["all"]);
    expect(checked(menuRows(three, "/code/acme", "project"))).toEqual(["/code/acme"]);
    // "project" with no project reads as All projects.
    expect(checked(menuRows([], null, "project"))).toEqual(["all"]);
  });
  test("search filters only past SEARCH_FROM; All projects stays; no match says so", () => {
    const few = Array.from({ length: SEARCH_FROM }, (_, i) => `/code/p${i}`);
    expect(menuRows(few, few[0]!, "all", "zzz").filter((r) => r.kind === "project")).toHaveLength(SEARCH_FROM);
    const many = [...few, "/code/zephyr"];
    const hit = menuRows(many, many[0]!, "all", "zeph");
    expect(hit.map((r) => r.kind)).toEqual(["all", "divider", "project"]);
    expect(menuRows(many, many[0]!, "all", "nothing").map((r) => r.kind)).toEqual(["all", "divider", "empty"]);
  });
  test("no projects: only All projects, no divider", () => {
    expect(menuRows([], null, "all").map((r) => r.kind)).toEqual(["all"]);
  });
  test("type-ahead finds the first name that starts with what was typed", () => {
    const rows = menuRows(three, "/code/orbit", "all");
    expect(typeAhead(rows, "z")).toBe(4);
    expect(typeAhead(rows, "AC")).toBe(3);
    expect(typeAhead(rows, "q")).toBe(-1);
  });
  test("the button says the choice", () => {
    expect(triggerLabel("all", "/code/orbit")).toBe("All projects");
    expect(triggerLabel("project", "/code/orbit")).toBe("orbit");
    expect(triggerLabel("project", null)).toBe("All projects");
  });
});

describe("the control", () => {
  test("one HIT-tall menu button with the choice and a chevron, no segmented pill", () => {
    const html = renderToStaticMarkup(createElement(ScopeControl, { project: "/code/orbit", projects: three, value: "project", onChange: () => {}, onPick: () => {} }));
    expect(html).toContain("Applies to");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("data-scope-trigger");
    expect(html).toContain("height:26px");
    expect(html).toContain(">orbit</span>");
    expect(html).not.toContain("agx-orch-seg");
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});

describe("the list is the Open projects dialog's", () => {
  const saved = api.gitReposAll;
  afterEach(() => { (api as { gitReposAll: unknown }).gitReposAll = saved; resetScannedRepos(); });
  test("13 scanned repos, one hidden: 12 listed, read with scan", async () => {
    const roots = Array.from({ length: 13 }, (_, i) => `/code/demo${i}`);
    let scanned: boolean | undefined;
    (api as { gitReposAll: unknown }).gitReposAll = async (scan?: boolean) => { scanned = scan; return { repos: roots.map((root) => ({ root })), hidden: ["/code/demo12"] }; };
    const r = await scannedReposOnce();
    expect(scanned).toBe(true);
    const hid = new Set(r.hidden ?? []);
    expect(projectList(["/code/demo3"], "/code/demo3", r.repos.map((x) => x.root).filter((x) => !hid.has(x)))).toHaveLength(12);
  });
  test("the orchestration pages use the scope's scanned list, not an unscanned read of their own", async () => {
    const src = await Bun.file(new URL("../src/components/orchestration/OrchestrationPane.tsx", import.meta.url)).text();
    expect(src).not.toContain("api.gitReposAll()");
    expect(src).toContain("withSaved(sc.projects");
  });
});
