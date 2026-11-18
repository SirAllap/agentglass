import { describe, expect, test } from "bun:test";
import { SHELL_GROUP_WIDTH, SHELL_RAIL_MIN, WIDE_COLUMN_WITH_RAIL, WIDE_RAIL_FROM_PX, showRailSpacer, wideHasRail } from "../src/components/settings/shell/shellRules.ts";
import { BROWSER_ROWS } from "../src/components/settings/pages/pageRows.ts";

const read = (f: string) => Bun.file(new URL(`../src/components/settings/${f}`, import.meta.url)).text();

// Settings ▸ Browser at a 1132 px window: the 380 px rail left the vault a 700 px column and every card cut its words.
describe("a wide page", () => {
  test("keeps the group, so its column starts at the same x as every other page", () => {
    expect(WIDE_COLUMN_WITH_RAIL + 32 + SHELL_RAIL_MIN).toBe(SHELL_GROUP_WIDTH);
  });
  test("shows a 192 px rail from 1200 content px, and none under it", () => {
    expect(WIDE_RAIL_FROM_PX).toBe(1200);
    expect(wideHasRail(1199)).toBe(false);
    expect(wideHasRail(1200)).toBe(true);
    expect(wideHasRail(2500)).toBe(true);
  });
  test("Browser is the wide page; Where it opens draws its preview beside the rows, not under them", async () => {
    const page = await read("pages/BrowserPage.tsx");
    expect(page).toContain("<SettingsPage wide ");
    expect(page).toContain('side={<BrowserPreview compact ');
    expect(page).not.toContain("preview={<BrowserPreview");
  });
  test("For agents is one row; the three it held open under it", async () => {
    const page = await read("pages/BrowserPage.tsx");
    expect(BROWSER_ROWS.find((r) => r.id === "browser.agentsHelp")?.label).toBe("How agents use this browser");
    expect(page).toContain('linkText={agentHelp ? "Hide help" : "Open help"}');
    expect(page.indexOf('row("browser.agentLines")')).toBeGreaterThan(page.indexOf("{agentHelp && "));
  });
  test("the sites table names its sensitive column in words, and no site name is cut", async () => {
    const vault = await read("pages/LoginVault.tsx");
    expect(vault).toContain('<span role="columnheader" className="grid place-items-center">Sensitive</span>');
    expect(vault).not.toContain('truncate font-mono text-[12px]">{s.site}');
  });
});

describe("rail spacer", () => {
  const base = { rail: false, chips: false, aside: false, wide: false, wideRail: true };
  test("a plain rail-less page keeps it", () => expect(showRailSpacer(base)).toBe(true));
  test("a wide page too narrow for its rail does not take the 224 px", () => expect(showRailSpacer({ ...base, wide: true, wideRail: false })).toBe(false));
  test("a wide page that fits the rail but has one section keeps it", () => expect(showRailSpacer({ ...base, wide: true })).toBe(true));
  test("rail, chips or aside show none", () => {
    for (const k of ["rail", "chips", "aside"] as const) expect(showRailSpacer({ ...base, [k]: true })).toBe(false);
  });
});
