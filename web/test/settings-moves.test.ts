import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { modalSource } from "./settingsSource.ts";
import { resolvePane } from "../src/lib/openSettings.ts";
import { SETTINGS_PAGES, SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";

const src = modalSource();
const palette = await Bun.file(new URL("../src/components/CommandPalette.tsx", import.meta.url)).text();

function fn(name: string): string {
  const a = src.indexOf(`function ${name}(`);
  expect(a).toBeGreaterThan(-1);
  return src.slice(a, src.indexOf("\n}\n", a) + 3);
}
// The modal's block for one page: from its show("x") marker to the next page's.
function block(id: string): string {
  const a = src.indexOf(`{show("${id}") &&`);
  expect(a).toBeGreaterThan(-1);
  const next = src.indexOf("{ql && show(", a);
  return src.slice(a, next > -1 ? next : undefined);
}
const rowsOn = (pane: string) => SETTINGS_ROWS.filter((r) => r.pane === pane).map((r) => r.label);

describe("slice 4 moves", () => {
  test("Terminal runs on is a row of Advanced > Terminal engine, the Terminal page points to it", () => {
    const rows = readFileSync(new URL("../src/components/settings/pages/TmuxRows.tsx", import.meta.url), "utf8");
    expect(rows).toContain("api.tmuxSettingsSave({ terminal: v })");
    expect(rowsOn("advanced")).toContain("Terminal runs on");
    expect(rowsOn("terminal")).not.toContain("Terminal runs on");
    expect(readFileSync(new URL("../src/components/settings/pages/TerminalPage.tsx", import.meta.url), "utf8")).toContain('openSettings("advanced")');
  });

  test("Agent browser use is the Browser page's For agents section; Browser keeps logins", () => {
    // The Browser page draws both sections itself now (the Agents page no longer carries the browser card).
    // 323e09d94 renamed the section to "Login vault" on purpose (the vault page); the id stays "logins".
    expect(block("browser")).toContain('<Section id="logins" title="Login vault"');
    expect(block("browser")).toContain('<Section id="agents" title="For agents"');
    expect(block("browser")).not.toContain("AgentBrowserPane");
    // Lot 7: the trust rows live on Permissions > Browser access; Browser keeps only a link row.
    expect(block("browser")).not.toContain("<WhoMayDriveBrowser");
    expect(block("browser")).not.toContain("<WorkerBrowserReach");
    expect(block("browser")).toContain("importCookies(");
    expect(fn("AgentBrowserPane")).not.toContain("<CookieImport />");
  });

  test("GitHub allowance is an open card on Budgets (the read runs on open either way), gone from Tools & services", () => {
    // Budgets folds into Engines & usage (shared/uiActions.ts aliases); the allowance card is drawn there.
    expect(block("engines")).toContain("<GhBudget");
    // The card is rows on the Engines & usage section now (no SettingsCard of its own).
    // GhBudget lives in settings/pages/GhAllowance.tsx so the row index finds its row on the engines page.
    const gh = readFileSync(new URL("../src/components/settings/pages/GhAllowance.tsx", import.meta.url), "utf8");
    expect(gh).toContain('label="How much of your GitHub allowance is left"');
    expect(gh).not.toContain("<SettingsCard");
    expect(gh).not.toContain("fold=");
    expect(block("connections")).not.toContain("GhBudget");
  });

  test("Diff syntax theme is a Diff row on the same key the diff views persist", async () => {
    expect(rowsOn("diff")).toContain("Diff syntax theme");
    expect(block("diff")).toContain('{...row("diff.syntaxTheme")}');
    // The row calls its def, and the def wraps the same setter the toolbar's key goes through.
    expect(block("diff")).toContain('setting("diff.syntaxTheme").set(v)');
    expect(await Bun.file(new URL("../src/lib/settingsRegistry.ts", import.meta.url)).text()).toContain("setDiffThemePref(v as string)");
    const prefs = await Bun.file(new URL("../src/lib/diffPrefs.ts", import.meta.url)).text();
    expect(prefs).toContain("THEME_KEY");
    expect(prefs).not.toContain('"agentglass.diffTheme"');
  });

  test("Opening files is gone, and its links are in the palette and Help", async () => {
    expect(src).not.toMatch(/\{ id: "open", label: "[^"]*", group:/); // no Settings tab of that id (a Diff section and a floating-button option use the word)
    expect(SETTINGS_PAGES.some((p) => p.id === "open")).toBe(false);
    expect(palette).not.toContain('id: "stats"');
    expect(palette).toContain('id: "help"');
    const help = await Bun.file(new URL("../src/components/HelpLegend.tsx", import.meta.url)).text();
    expect(help).toContain("Command palette");
  });

  test("open aliases to prefs for a remembered pane and for openSettings", () => {
    expect(resolvePane("open")).toBe("appearance");
    expect(resolvePane("hooks")).toBe("hooks");
    expect(src).toContain("restorePane(localStorage.getItem(LAST_PANE_KEY))");
    expect(src).toContain("resolvePane(jump.pane)");
  });

  test("the generated index is fresh", () => {
    expect(rowsOn("advanced")).toContain("Terminal runs on"); // one home (ia.md)
    expect(SETTINGS_ROWS.find((r) => r.pane === "advanced" && r.label === "Terminal runs on")?.section).toBe("Terminal engine");
    expect(rowsOn("engines")).toContain("How much of your GitHub allowance is left");
    expect(rowsOn("diff")).toContain("Diff syntax theme");
    expect(rowsOn("open")).toEqual([]);
  });
});
