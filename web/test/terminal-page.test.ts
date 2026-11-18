import { describe, expect, test } from "bun:test";
import { TERMINAL_ROWS, TERMINAL_SECTIONS } from "../src/components/settings/pages/terminalRows.ts";
import { hasRail, orderSections } from "../src/components/settings/shell/shellRules.ts";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../src/components/settings/pages/TerminalPage.tsx", import.meta.url), "utf8");

describe("Terminal page rows", () => {
  test("every row id appears once", () => {
    const ids = TERMINAL_ROWS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("23 rows: the ia.md Terminal rows, the pane bar marker and the reset action", () => {
    expect(TERMINAL_ROWS.length).toBe(23);
  });
  test("every row sits in a known section and the page renders it", () => {
    for (const r of TERMINAL_ROWS) {
      expect(TERMINAL_SECTIONS as readonly string[]).toContain(r.section);
      expect(page).toContain(`"${r.id}"`);
    }
  });
  test("help is one sentence of 14 words at most, ends with a full stop", () => {
    for (const r of TERMINAL_ROWS) {
      const words = r.help.trim().split(/\s+/).length;
      expect({ id: r.id, ok: words <= 14 }).toEqual({ id: r.id, ok: true });
      expect(r.help.endsWith(".")).toBe(true);
      expect(r.label.endsWith(".")).toBe(false);
    }
  });
  test("danger zone is last and the rail applies (6 sections)", () => {
    const secs = TERMINAL_SECTIONS.map((id) => ({ id, kind: id === "danger" ? "danger" as const : "normal" as const }));
    const ordered = orderSections([...secs].reverse());
    expect(ordered[ordered.length - 1].id).toBe("danger");
    expect(hasRail(secs.length)).toBe(true);
  });
  test("every row renders a control kind (no row without a control)", () => {
    expect(page).not.toContain('kind="fact"');
    expect((page.match(/kind="control"/g) ?? []).length).toBeGreaterThanOrEqual(TERMINAL_ROWS.length - 1);
  });
});

describe("Section preview slot", () => {
  test("a Section renders one preview block under its rows", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Section } = await import("../src/components/settings/shell/Section.tsx");
    const html = renderToStaticMarkup(createElement(Section, { id: "x", title: "X", preview: createElement("i", null, "P"), children: createElement("b", null, "row") }));
    expect(html.match(/data-section-preview/g)?.length).toBe(1);
    expect(html.indexOf("row")).toBeLessThan(html.indexOf("data-section-preview"));
    expect(renderToStaticMarkup(createElement(Section, { id: "y", title: "Y", children: null }))).not.toContain("data-section-preview");
  });
  test("the font preview and the marker row are on the page", () => {
    expect(page).toContain("preview={fontPreview}");
    expect(page).toContain('row("terminal.paneBarMarker")');
  });
});
