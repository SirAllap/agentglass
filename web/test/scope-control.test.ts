/*
 * The "Applies to" control: what each row says, when the summary shows, that
 * switching scope never drops an override, and that a reset can be undone.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScopeControl, ScopeSummary, ScopeTag } from "../src/components/settings/scope/ScopeControl.tsx";
import {
  choiceFor, enterPick, filterProjects, menuRows, withSaved, pickedProject, projectList, rootFor, resetOf, resetToast, rowTag, scopeOptions, summaryText, valueOf, visibleRows, type ScopeRow,
} from "../src/components/settings/scope/scopeModel.ts";

const rows: ScopeRow<number>[] = [
  { id: "a", general: 4 },
  { id: "b", general: 4, own: 2 },
  { id: "c", general: 6, own: 9 },
  { id: "mem", general: 8, own: 1, machine: true },
];
const show = (n: number) => String(n);

describe("options", () => {
  test("project open: both options on", () => {
    const o = scopeOptions("/code/orbit");
    expect(o.map((x) => x.label)).toEqual(["All projects", "Only orbit"]);
    expect(o.every((x) => !x.disabled)).toBe(true);
  });
  test("no project: second option disabled with the reason", () => {
    const o = scopeOptions(null);
    expect(o[1]!.disabled).toBe(true);
    expect(o[1]!.reason).toBe("Open a project to set its own values");
    const html = renderToStaticMarkup(createElement(ScopeControl, { project: null, value: "all", onChange: () => {} }));
    expect(html).toContain("Open a project to set its own values");
    expect(html).toContain("disabled");
  });
  test("store root: empty for all, folder for project", () => {
    expect(rootFor("all", "/code/orbit")).toBe("");
    expect(rootFor("project", "/code/orbit")).toBe("/code/orbit");
    expect(rootFor("project", null)).toBe("");
    expect(choiceFor("/code/orbit", "/code/orbit")).toBe("project");
    expect(choiceFor("/code/gone", "/code/orbit")).toBe("all");
    expect(choiceFor("", "/code/orbit")).toBe("all");
  });
});

describe("row tags", () => {
  test("all projects: nothing extra", () => expect(rowTag(rows[1]!, "all", show)).toEqual({ kind: "none" }));
  test("follows general", () => expect(rowTag(rows[0]!, "project", show)).toEqual({ kind: "same", text: "Same as all projects" }));
  test("differs says what it was and what reset gives", () => {
    expect(rowTag(rows[1]!, "project", show)).toEqual({
      kind: "differs", text: "Differs from all projects (was 4)", reset: "Reset to all projects (4)",
    });
  });
  test("machine value is locked in both scopes", () => {
    expect(rowTag(rows[3]!, "all", show)).toEqual({ kind: "locked", text: "This one is set for every project, not per project." });
    expect(rowTag(rows[3]!, "project", show)).toEqual({ kind: "locked", text: "This one is set for every project. Change it under All projects." });
  });
  test("tag renders the reset link", () => {
    const html = renderToStaticMarkup(createElement(ScopeTag, { tag: rowTag(rows[1]!, "project", show), onReset: () => {} }));
    expect(html).toContain("Reset to all projects (4)");
    expect(html).toContain("data-own-dot");
    expect(html).not.toContain("title=");
  });
});

describe("summary and filter", () => {
  test("only in the project state, machine rows not counted", () => {
    expect(summaryText(rows, "all")).toBeNull();
    expect(summaryText(rows, "project")).toBe("2 settings differ from all projects · Show them");
    expect(summaryText([rows[0]!], "project")).toBeNull();
    expect(summaryText([rows[1]!], "project")).toBe("1 setting differs from all projects · Show them");
  });
  test("Show filters to differing rows, only in the project state", () => {
    expect(visibleRows(rows, "project", true).map((r) => r.id)).toEqual(["b", "c"]);
    expect(visibleRows(rows, "all", true)).toHaveLength(4);
    expect(visibleRows(rows, "project", false)).toHaveLength(4);
  });
  test("summary renders with the press", () => {
    const html = renderToStaticMarkup(createElement(ScopeSummary, { text: summaryText(rows, "project"), filtered: false, onShow: () => {} }));
    expect(html).toContain("Show them");
    expect(renderToStaticMarkup(createElement(ScopeSummary, { text: null, filtered: false, onShow: () => {} }))).not.toContain("Show");
  });
});

describe("never discards", () => {
  test("switching scope reads another value, rows are untouched", () => {
    const before = JSON.stringify(rows);
    expect(valueOf(rows[1]!, "all")).toBe(4);
    expect(valueOf(rows[1]!, "project")).toBe(2);
    expect(valueOf(rows[0]!, "project")).toBe(4);
    expect(valueOf(rows[3]!, "project")).toBe(8);
    expect(JSON.stringify(rows)).toBe(before);
  });
  test("reset keeps the removed value for Undo; no override, nothing to reset", () => {
    expect(resetOf(rows[1]!)).toEqual({ id: "b", own: 2 });
    expect(resetOf(rows[0]!)).toBeNull();
    expect(resetOf(rows[3]!)).toBeNull();
  });
  test("toast", () => expect(resetToast("/code/orbit", "Workers at once")).toBe("orbit now follows all projects for Workers at once."));
});

describe("project picker", () => {
  const many = Array.from({ length: 12 }, (_, i) => `/code/proj${i}`);
  test("open project first, none twice", () => {
    expect(projectList(["/code/a", "/code/b", "/code/c"], "/code/b")).toEqual(["/code/b", "/code/a", "/code/c"]);
    expect(projectList(["/code/a"], null)).toEqual(["/code/a"]);
    // Every project the app knows is listed, not only the open ones; none twice, the open one first.
    expect(projectList(["/code/a"], "/code/a", ["/code/z", "/code/a", "/code/y"])).toEqual(["/code/a", "/code/z", "/code/y"]);
    expect(projectList([], null, ["/code/x", "/code/x"])).toEqual(["/code/x"]);
  });
  test("search only from 9 projects; matches name or folder, any case", () => {
    expect(filterProjects(many.slice(0, 8), "zzz")).toHaveLength(8);
    expect(filterProjects(many, "PROJ1").map((p) => p.slice(-6))).toEqual(["/proj1", "proj10", "proj11"]);
    expect(filterProjects(many, "  ")).toHaveLength(12);
  });
  test("remembered project wins while known, else the open one", () => {
    expect(pickedProject("/code/b", ["/code/a", "/code/b"], "/code/a")).toBe("/code/b");
    expect(pickedProject("/code/gone", ["/code/a"], "/code/a")).toBe("/code/a");
    expect(pickedProject("", ["/code/a"], "/code/a")).toBe("/code/a");
    expect(choiceFor("/code/b", pickedProject("/code/b", ["/code/b"], "/code/a"))).toBe("project");
  });
  test("Enter in the search field picks only once something is typed", () => {
    // The field has focus when the menu opens: Enter on nothing typed must not scope the page.
    expect(enterPick(menuRows(many, many[0]!, "all", ""), "")).toBeNull();
    expect(enterPick(menuRows(many, many[0]!, "all", "  "), "  ")).toBeNull();
    expect(enterPick(menuRows(many, many[0]!, "all", "proj3"), "proj3")).toBe("/code/proj3");
    expect(enterPick(menuRows(many, many[0]!, "all", "zzz"), "zzz")).toBeNull();
  });
  test("saved values never bring back a hidden project", () => {
    const hidden = new Set(["/code/x"]);
    expect(withSaved(["/code/a"], ["/code/x", "/code/b", "/code/a"], hidden)).toEqual(["/code/a", "/code/b"]);
    expect(withSaved(["/code/a"], [], new Set())).toEqual(["/code/a"]);
  });
  test("control renders a labelled menu button and a fixed summary line", () => {
    const html = renderToStaticMarkup(createElement(ScopeControl, { project: "/code/orbit", projects: ["/code/orbit", "/code/acme"], value: "project", onChange: () => {}, onPick: () => {} }));
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("orbit");
    expect(renderToStaticMarkup(createElement(ScopeSummary, { text: null, filtered: false, onShow: () => {} }))).toContain("h-[18px]");
  });
});
