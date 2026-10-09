import { describe, expect, test } from "bun:test";
import { resolvePane } from "../src/lib/openSettings.ts";
import { SETTINGS_PAGES, SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";

const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();
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
  test("Terminal runs on is a Terminal section, not a tmux row", () => {
    expect(block("terminal")).toContain("<TerminalRunsOn");
    expect(fn("TerminalRunsOn")).toContain('label="Terminal runs on"');
    expect(fn("TmuxPane")).not.toContain('label="Terminal runs on"');
    expect(fn("TmuxPane")).toContain('label="Where a Terminal opens a shell"');
    expect(src).toContain('onGoTerminal={() => { setPane("terminal"');
    expect(fn("TerminalRunsOn")).toContain("api.tmuxSettingsSave({ terminal: mode })");
  });

  test("How new chats run is on Agents, not tmux", () => {
    expect(block("hooks")).toContain('label="How new chats run"');
    expect(block("tmux")).not.toContain("How new chats run");
    expect(block("hooks")).toContain("setChatEnginePref(next)");
  });

  test("Agent browser use is on Agents behind HAS_BROWSER; Browser keeps logins", () => {
    expect(block("hooks")).toContain("{HAS_BROWSER && <AgentBrowserPane");
    expect(block("browser")).not.toContain("AgentBrowserPane");
    expect(block("browser")).toContain("<BrowserPane />");
    expect(block("browser")).toContain("<CookieImport />");
    expect(fn("AgentBrowserPane")).not.toContain("<CookieImport />");
  });

  test("GitHub API budget is a Fold on Budgets, gone from Tools & services", () => {
    expect(block("budgets")).toContain("<GhBudget");
    expect(fn("GhBudget")).toContain('<Fold label="GitHub API budget">');
    expect(block("connections")).not.toContain("GhBudget");
  });

  test("Diff syntax theme is a Diff row on the same key the diff views persist", async () => {
    expect(block("diff")).toContain('label="Diff syntax theme"');
    // The row calls its def, and the def wraps the same setter the toolbar's key goes through.
    expect(block("diff")).toContain('setting("diff.syntaxTheme").set(v)');
    expect(await Bun.file(new URL("../src/lib/settingsRegistry.ts", import.meta.url)).text()).toContain("setDiffThemePref(v as string)");
    const prefs = await Bun.file(new URL("../src/lib/diffPrefs.ts", import.meta.url)).text();
    expect(prefs).toContain("THEME_KEY");
    expect(prefs).not.toContain('"agentglass.diffTheme"');
  });

  test("Opening files is gone, and its links are in the palette and Help", async () => {
    expect(src).not.toContain('id: "open"');
    expect(SETTINGS_PAGES.some((p) => p.id === "open")).toBe(false);
    expect(palette).toContain('id: "stats"');
    expect(palette).toContain('id: "help"');
    const help = await Bun.file(new URL("../src/components/HelpLegend.tsx", import.meta.url)).text();
    expect(help).toContain("Command palette");
  });

  test("open aliases to prefs for a remembered pane and for openSettings", () => {
    expect(resolvePane("open")).toBe("prefs");
    expect(resolvePane("hooks")).toBe("hooks");
    expect(src).toContain("resolvePane(saved)");
    expect(src).toContain("resolvePane(jump.pane)");
  });

  test("the generated index is fresh", () => {
    expect(rowsOn("terminal")).toContain("Terminal runs on");
    expect(rowsOn("tmux")).not.toContain("Terminal runs on");
    expect(rowsOn("hooks")).toContain("How new chats run");
    expect(rowsOn("budgets")).toContain("GitHub API budget");
    expect(rowsOn("diff")).toContain("Diff syntax theme");
    expect(rowsOn("open")).toEqual([]);
  });
});
