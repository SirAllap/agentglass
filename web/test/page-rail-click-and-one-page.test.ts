import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("settings rail click and one page", () => {
  test("the click sets the active entry before it scrolls, and the spy waits for the scroll to end", () => {
    const rail = src("components/settings/shell/PageRail.tsx");
    expect(rail.indexOf("setActive(s.id)")).toBeGreaterThan(-1);
    expect(rail.indexOf("setActive(s.id)")).toBeLessThan(rail.indexOf("jumpToSection(scrollRoot(), s.id)"));
    expect(rail).toContain("if (pinned.current) return;");
    expect(rail).toContain('["wheel", "touchstart", "keydown", "pointerdown"]');
    expect(rail).not.toContain("setTimeout");
  });
  test("FlowReviewPage keeps only a summary card that opens Polaris; PolarisPage owns the view", () => {
    expect(src("components/settings/pages/FlowReviewPage.tsx")).not.toContain("<PolarisView");
    expect(src("components/settings/pages/FlowReviewPage.tsx")).toContain("Open Polaris settings");
    expect(src("components/SettingsModal.tsx")).toContain('show("polaris") && <PolarisPage />');
  });
});

describe("rail bottom and hover", () => {
  test("the spy passes the at-bottom state and entries have a hover rule", () => {
    expect(src("components/settings/shell/PageRail.tsx")).toContain("root.scrollHeight - 2");
    expect(src("index.css")).toContain('[data-rail-entry]:not([aria-current="true"]):hover');
  });
});

describe("rail top is the row top", () => {
  test("outside the chip band the scope header lives in the content column, not above the row", () => {
    const page = src("components/settings/shell/SettingsPage.tsx");
    expect(page).toContain("{chips && header}");
    expect(page).toContain("{!chips && header}");
    expect(page.indexOf("data-settings-column")).toBeLessThan(page.indexOf("{!chips && header}"));
  });
});
