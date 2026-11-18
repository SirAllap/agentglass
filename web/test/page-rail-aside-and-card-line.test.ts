import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("right column and card line", () => {
  test("rail and aside share one measured sticky top", () => {
    expect(src("components/settings/shell/PageRail.tsx")).toContain("export function useStickyTop");
    const page = src("components/settings/shell/SettingsPage.tsx");
    expect(page).toContain("useStickyTop(asideRef");
    expect(page).toContain("top: asideTop ?? 24");
    expect(page).not.toContain("sticky top-0");
  });
  test("a card's first row has no top line of its own", () => {
    expect(src("components/settings/shell/Section.tsx")).toContain("data-section-card");
    expect(src("index.css")).toContain("[data-section-card] > [data-row]:first-child { border-top: 0 !important; }");
  });
});
