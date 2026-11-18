/*
 * Decisions taken out of the Settings modal and asserted against source, since
 * there is no renderer here. Each names the defect it stops coming back.
 */
import { describe, expect, test } from "bun:test";
import { modalSource } from "./settingsSource.ts";
import { SETTINGS_PAGES, SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";
import { searchSettings, type SettingsPage } from "../src/lib/settingsIndex.ts";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const modal = modalSource();
const row = await read("components/SettingRow.tsx");
const app = await read("App.tsx");
const bar = await read("components/CommandBar.tsx");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join("\n");

describe("an in-modal link works every time", () => {
  test("App hands the modal a request with a nonce, not two strings that can stay equal", () => {
    expect(app).toMatch(/n: \(j\?\.n \?\? 0\) \+ 1/);
    expect(app).toContain("jump={settingsJump}");
    expect(code(app)).not.toContain("jumpToRow");
  });
  test("both effects depend on the whole request, so the same pane twice still runs", () => {
    expect(code(modal)).toContain("}, [open, jump]);");
    expect(code(modal)).toContain("if (open && jump?.row) setPendingJump({ page: jump.pane ? resolvePane(jump.pane) : null, row: jump.row }); }, [open, jump]);");
  });
});

describe("Reset page leaves typed text alone", () => {
  test("group rules and word separators are not in pageDirty", () => {
    const at = modal.indexOf("const pageDirty");
    const end = modal.indexOf("const pageModified", at);
    const block = code(modal.slice(at, end));
    expect(block).not.toContain("setTabGroupRulesText");
    expect(block).not.toContain("setWordSeparators");
    expect(block).toContain("setRendererPref");
  });
});

describe("a fold does not hide what search found", () => {
  test("open while filtering or while a flash is pending", () => {
    const fold = row.slice(row.indexOf("export function Fold("));
    expect(fold).toContain("useContext(Filter)");
    expect(fold).toMatch(/const shown = open \|\| on \|\| !!flash/);
    expect(code(fold)).toContain("{shown && (");
  });
  test("the modal publishes the pending flash through the filter context", () => {
    expect(code(modal)).toContain("flash: flashRow");
  });
});

describe("no phantom rows", () => {
  test("Reminder alarm voice is not indexed", () => {
    expect(SETTINGS_ROWS.some((r) => r.label === "Reminder alarm voice")).toBe(false);
    expect(modal).not.toContain("alarmOnRow");
  });
  test("Browser is a page, and rows of a page the caller lacks are not results", () => {
    expect(SETTINGS_PAGES.some((p) => p.id === "browser")).toBe(true);
    const without = SETTINGS_PAGES.filter((p) => p.id !== "browser").map((p) => ({ ...p, kw: "" }) as SettingsPage);
    expect(searchSettings("search engine", without).some((r) => r.pane === "browser")).toBe(false);
    const withIt = SETTINGS_PAGES.map((p) => ({ ...p, kw: "" }) as SettingsPage);
    expect(searchSettings("search engine", withIt).some((r) => r.pane === "browser")).toBe(true);
    expect(code(bar)).toContain('HAS_BROWSER ? ALL_SETTINGS_PAGES');
  });
});

describe("Silence all is findable", () => {
  test("notifications kw carries the words", () => {
    const m = modal.match(/id: "notifications"[^\n]*kw: "([^"]*)"/);
    expect(m).not.toBeNull();
    for (const w of ["silence", "none", "all"]) expect(m![1]!.split(" ")).toContain(w);
  });
});

describe("the modal re-reads what other screens write", () => {
  test("an `if (open)` effect refreshes diff and terminal getters", () => {
    const at = modal.indexOf("Re-read them whenever it opens");
    const body = modal.slice(at, modal.indexOf("}, [open]);", at));
    for (const g of ["diffSplit()", "diffWrap()", "diffThemePref()", "currentTermSize()", "currentAccent()"]) expect(body).toContain(g);
  });
});

describe("the type sample hangs under the Font row", () => {
  test("it is the Look section's own preview, with no eyebrow and no box of its own", () => {
    const page = modalSource();
    const at = page.indexOf("const fontPreview = (");
    expect(at).toBeGreaterThan(-1);
    const sample = page.slice(at, page.indexOf("const down", at));
    expect(sample).toMatch(/<div aria-label="How the chosen face looks" className="whitespace-pre/);
    expect(sample).not.toContain("panel-eyebrow");
    expect(sample).not.toContain("border: EDGE");
    expect(page).toContain('<Section id="look" title="Look" preview={fontPreview}>');
  });
});
