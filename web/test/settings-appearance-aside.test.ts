import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../src/components/settings/${p}`, import.meta.url).pathname, "utf8");

describe("Appearance page live preview", () => {
  test("the page hands its own values to the preview aside", () => {
    const page = src("pages/AppearancePage.tsx");
    expect(page).toContain("aside={<AppearancePreview");
    for (const prop of ["theme={palette}", "accent={accent}", "density={density}", "fontPx={fontPx}", "translucent={translucent}"]) expect(page).toContain(prop);
  });
  test("the shell renders the aside sticky in the right column and under the sections in the chip band", () => {
    const shell = src("shell/SettingsPage.tsx");
    expect(shell).toContain("data-page-aside");
    expect(shell).toContain("useStickyTop(asideRef");
    expect(shell).toMatch(/chips \? "min-w-0"/);
  });
});
