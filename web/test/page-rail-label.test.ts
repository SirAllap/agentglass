import { describe, expect, test } from "bun:test";

// The "On this page" heading was drawn in the entries' size and weight, so it read as one more
// entry; a click on it only selected its text. It is a label: smaller, upper case, quieter, unselectable.
const src = await Bun.file(new URL("../src/components/settings/shell/PageRail.tsx", import.meta.url)).text();

describe("the rail's heading", () => {
  test("is a quiet label that cannot be selected", () => {
    const line = src.split("\n").find((l) => l.includes(">On this page</div>"));
    expect(line).toBeDefined();
    expect(line!).toContain("uppercase");
    expect(line!).toContain("select-none");
    expect(line!).toContain("var(--text3)");
    expect(line!).not.toContain("font-medium");
  });
});

// A 90ch cap wrapped the page summary onto two lines with half the header empty beside it.
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
describe("the page header's summary", () => {
  test("uses the header's whole width", () => {
    const rule = css.split("\n").find((l) => l.startsWith(".agx-ph-sum {"));
    expect(rule).toBeDefined();
    expect(rule!).not.toContain("max-width");
  });
});

// Without scan the Applies-to menu read only the registered repos: 2 listed on a machine with 13.
const scope = await Bun.file(new URL("../src/components/settings/scope/useScope.ts", import.meta.url)).text();
describe("the Applies-to project menu", () => {
  test("reads every repository on the machine, minus the hidden ones", () => {
    expect(scope).toContain("api.gitReposAll(true)");
    expect(scope).toContain("void scannedReposOnce().then(");
    expect(scope).toContain("r.hidden");
  });
});

// w-fit made a rail page 944 px and an aside page 1132 px wide: centred, the column jumped ~94 px between them.
const page = await Bun.file(new URL("../src/components/settings/shell/SettingsPage.tsx", import.meta.url)).text();
const railSrc = await Bun.file(new URL("../src/components/settings/shell/PageRail.tsx", import.meta.url)).text();
const { SHELL_GROUP_WIDTH, SHELL_SIZE } = await import("../src/components/settings/shell/shellRules.ts");
describe("the Settings page group", () => {
  test("is one width on every page (720 + 32 + aside), centred", () => {
    expect(SHELL_GROUP_WIDTH).toBe(720 + 32 + SHELL_SIZE.aside);
    const line = page.split("\n").find((l) => l.includes("data-settings-group"));
    expect(line).toBeDefined();
    expect(line!).toContain("mx-auto");
    expect(line!).toContain("rail || aside || spacer ? SHELL_GROUP_WIDTH : SHELL_COLUMN");
    expect(line!).not.toContain("w-fit");
  });
  test("the rail and the spacer take the aside's width, so the column sits at the same x", () => {
    expect(page).toContain("{spacer && <div data-rail-spacer aria-hidden style={{ width: SHELL_SIZE.aside");
    expect(railSrc).toContain("width: SHELL_SIZE.aside");
    expect(railSrc).not.toContain("w-[192px] shrink-0");
  });
});

// Measured at 1600x1000: Workers (one section, no rail) centred its column at x=581 while every other page
// starts at x=375. A page with no right column keeps the empty rail width, so the left edge never depends on the rail.
describe("a page with no right column", () => {
  test("keeps the spacer, so the column's left edge does not depend on the rail", () => {
    expect(page).toContain("const spacer = showRailSpacer({ rail, chips, aside: !!aside, wide, wideRail });");
  });
});

// Entries 192 px wide in a 380 px column left the page visibly off-centre: 478 px free left, 697 px right.
describe("the rail's entries", () => {
  test("fill the rail column", () => {
    const rail = src;
    expect(rail).toContain('"block w-full text-left px-2 py-1 rounded text-[12px]"');
    expect(rail).not.toContain("w-[192px] max-w-full text-left");
  });
});
