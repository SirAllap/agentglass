/* The Settings page shell: pure rules plus a static render of the pieces. */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { activeSection, hasRail, isChipBand, orderSections, rowKindAllowed } from "../src/components/settings/shell/shellRules.ts";
import { SettingRow } from "../src/components/settings/shell/SettingRow.tsx";
import { Section, MoreOptions, DangerZone } from "../src/components/settings/shell/Section.tsx";
import { SettingsPage } from "../src/components/settings/shell/SettingsPage.tsx";

const sec = (id: string, kind: "normal" | "more" | "danger" = "normal") => ({
  id, title: id, kind, body: createElement(Section, { id, title: id, kind, children: null }),
});

describe("rail rule", () => {
  it("needs 2 sections", () => {
    expect(hasRail(1)).toBe(false);
    expect(hasRail(2)).toBe(true);
  });
  it("chips under 820px of content width", () => {
    expect(isChipBand(819)).toBe(true);
    expect(isChipBand(820)).toBe(false);
    // A page with an aside needs ~1230 content px before the preview sits beside the rows.
    expect(isChipBand(1229, true)).toBe(true);
    expect(isChipBand(1230, true)).toBe(false);
  });
});

describe("section order", () => {
  it("forces danger last and more before it, stable inside a kind", () => {
    const out = orderSections([{ id: "d", kind: "danger" as const }, { id: "a", kind: "normal" as const }, { id: "m", kind: "more" as const }, { id: "b", kind: "normal" as const }]);
    expect(out.map((s) => s.id)).toEqual(["a", "b", "m", "d"]);
  });
  it("active entry follows the line", () => {
    expect(activeSection(["a", "b", "c"], [-300, 40, 500])).toBe("b");
    expect(activeSection(["a", "b"], [200, 600])).toBe("a");
    // At the bottom of the scroll box the last section wins, even if its top never reached the line.
    expect(activeSection(["a", "b", "c"], [-300, -100, 400], 80, true)).toBe("c");
    expect(activeSection(["a", "b", "c"], [-300, -100, 400], 80, false)).toBe("b");
  });
});

describe("row kinds", () => {
  it("fact only on inspect", () => {
    expect(rowKindAllowed("fact", "main")).toBe(false);
    expect(rowKindAllowed("fact", "inspect")).toBe(true);
    expect(rowKindAllowed("locked", "advanced")).toBe(true);
  });
  it("row text has a hierarchy: semibold ink label, muted regular help, muted mono code", () => {
    const h = renderToStaticMarkup(createElement(SettingRow, { kind: "control", label: "L", help: "H", code: "cd {{worktree}}", control: createElement("input") }));
    expect(h).toMatch(/data-row-label[^>]*class="[^"]*font-semibold[^"]*"[^>]*var\(--text\)/);
    expect(h).toMatch(/data-row-help[^>]*class="[^"]*text-\[12px\][^"]*font-normal[^"]*"[^>]*var\(--text2\)/);
    expect(h).toMatch(/data-row-code[^>]*class="[^"]*font-mono[^"]*"[^>]*var\(--text2\)[^>]*>cd \{\{worktree\}\}/);
  });
  it("renders each kind, locked with its reason and a disabled control", () => {
    const c = renderToStaticMarkup(createElement(SettingRow, { kind: "control", label: "L", control: createElement("input") }));
    expect(c).toContain('data-row-kind="control"');
    const l = renderToStaticMarkup(createElement(SettingRow, { kind: "locked", label: "L", control: createElement("input"), reason: "Set by the environment" }));
    expect(l).toContain("Set by the environment");
    expect(l).toContain('aria-disabled="true"');
    const f = renderToStaticMarkup(createElement(SettingRow, { kind: "fact", label: "L", value: "/a/b" }));
    expect(f).toContain("Copy");
    expect(renderToStaticMarkup(createElement(SettingRow, { kind: "link", label: "L" }))).toContain("data-row-link");
  });
});

describe("page", () => {
  it("renders danger last and the rail from 2 sections", () => {
    const one = renderToStaticMarkup(createElement(SettingsPage, { title: "T", purpose: "P", sections: [sec("a")] }));
    expect(one).not.toContain("data-page-rail");
    // A one-section page keeps the rail's empty column: its left edge is the same as a rail page's.
    expect(one).toContain("data-rail-spacer");
    const five = renderToStaticMarkup(createElement(SettingsPage, { title: "T", purpose: "P", scopeSlot: createElement("i"), sections: [sec("z", "danger"), sec("a"), sec("b"), sec("m", "more"), sec("c")] }));
    expect(five).toContain("data-page-rail");
    expect(five).toContain("data-scope-slot");
    expect(five.lastIndexOf('data-section="z"')).toBeGreaterThan(five.indexOf('data-section="m"'));
  });
  it("more options is collapsed, danger zone is a danger section", () => {
    expect(renderToStaticMarkup(createElement(MoreOptions, null, null))).not.toContain("open");
    expect(renderToStaticMarkup(createElement(DangerZone, null, null))).toContain('data-section-kind="danger"');
  });
});

describe("review fixes", () => {
  const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
  it("rail is a direct child of the full-height row, not a bare wrapper", () => {
    const out = html(createElement(SettingsPage, { title: "T", purpose: "p", sections: ["a", "b", "c", "d", "e"].map((i) => sec(i)) }));
    // Wide content area (the first render, before any measuring): the rail is the LAST child of the row, so it sits right of the content.
    expect(out).toMatch(/<div class="flex gap-8 flex-row[^"]*">(?:(?!<nav)[\s\S])*<nav aria-label="On this page"/);
    expect(out).toContain("position:sticky");
    expect(out).toContain('data-page-rail="rail"');
    expect(out).not.toContain("min-[1100px]");
  });
  it("one header per page: the shell prints no title or purpose (the modal header owns them)", () => {
    const out = html(createElement(SettingsPage, { title: "Zed title", purpose: "Zed purpose line", sections: ["a", "b"].map((i) => sec(i)) }));
    expect(out).not.toContain("<h2");
    expect(out).not.toContain(">Zed purpose line<");
    expect(out).not.toContain(">Zed title<");
  });
  it("More options summary is keyboard reachable", () => {
    const out = html(createElement(MoreOptions, null, null));
    expect(out).not.toContain("tabindex");
  });
  it("locked row control is inert and aria-disabled", () => {
    const out = html(createElement(SettingRow, { kind: "locked", label: "L", control: createElement("input"), reason: "All projects only" }));
    expect(out).toMatch(/<div aria-disabled="true"[^>]*inert=""/);
  });
});

describe("no project open", () => {
  it("the scope control and the Git note both carry the Open a project action", async () => {
    const { ScopeControl } = await import("../src/components/settings/scope/ScopeControl.tsx");
    const out = renderToStaticMarkup(createElement(ScopeControl, { project: null, value: "all", onChange: () => {} }));
    expect(out).toMatch(/data-scope-trigger[^>]*disabled/);
    expect(out).toContain(">Open a project</button>");
    const named = renderToStaticMarkup(createElement(ScopeControl, { project: "/code/orbit", value: "project", onChange: () => {} }));
    expect(named).toContain(">orbit</span>");
  });
});
