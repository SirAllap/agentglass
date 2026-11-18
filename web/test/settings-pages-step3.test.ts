import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FILES_ROWS, DIFF_ROWS, BROWSER_ROWS, GIT_ROWS, type PageRowDef } from "../src/components/settings/pages/pageRows.ts";
import { hasRail } from "../src/components/settings/shell/shellRules.ts";

const src = (f: string) => readFileSync(new URL(`../src/components/settings/pages/${f}`, import.meta.url), "utf8");
const pages: Record<string, { file: string; rows: PageRowDef[]; sections: number; extra: string[] }> = {
  files: { file: "FilesPage.tsx", rows: FILES_ROWS, sections: 5, extra: [] },
  diffs: { file: "DiffsPage.tsx", rows: DIFF_ROWS, sections: 1, extra: [] },
  browser: { file: "BrowserPage.tsx", rows: BROWSER_ROWS, sections: 3, extra: [] },
  git: { file: "GitPage.tsx", rows: GIT_ROWS, sections: 3, extra: [] },
};

describe("step 3 pages: Files, Diffs, Browser, Git & PRs", () => {
  for (const [name, p] of Object.entries(pages)) {
    const code = src(p.file) + (name === "git" ? src("CleanupRows.tsx") : ""); // the Git cleanup rows live in CleanupRows
    test(`${name}: each row id once, rendered by the page, copy <= 14 words`, () => {
      const ids = p.rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const r of p.rows) {
        expect(code).toContain(`"${r.id}"`);
        expect(r.help.trim().split(/\s+/).length).toBeLessThanOrEqual(14);
        expect(r.help.endsWith(".")).toBe(true);
        expect(r.label.endsWith(".")).toBe(false);
      }
    });
    test(`${name}: no row without a control or link, no fact rows, no title=`, () => {
      expect(code).not.toContain('kind="fact"');
      expect(code).not.toMatch(/<(Button|div|span|input|button|label)\b[^>]*\stitle=/);
      expect(code).not.toMatch(/<SettingRow(?![^>]*kind=)/);
    });
    test(`${name}: rail rule by section count`, () => {
      expect(hasRail(p.sections)).toBe(p.sections >= 2);
    });
  }
  test("files: Danger zone is the last section and Density is not here", () => {
    const code = src("FilesPage.tsx");
    expect(code.lastIndexOf('id: "danger"')).toBeGreaterThan(code.lastIndexOf('id: "more"'));
    expect(FILES_ROWS.some((r) => r.label === "Density")).toBe(false);
  });
  test("diffs: one preview block, in the section", () => {
    expect(src("DiffsPage.tsx").match(/preview=\{/g)?.length).toBe(1);
  });
  test("routes: one line per page in the modal, old bodies gone", () => {
    const m = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");
    for (const t of ["<TerminalPage ", "<FilesPage ", "<DiffsPage ", "<BrowserPage ", "<GitPage "]) expect(m.split(t).length - 1).toBe(1);
    expect(m).not.toContain("<DiffSettingsPage");
    expect(m).not.toContain("function BrowserPane(");
  });
});
