import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const pagesDir = new URL("../src/components/settings/", import.meta.url);

describe("Settings paint, centring and old blocks", () => {
  test("a: Appearance renders each setting once: the old Window and Sidebar pages are gone", () => {
    const modal = src("components/SettingsModal.tsx");
    expect(modal).not.toContain("WindowSettingsPage");
    expect(modal).not.toContain("SidebarSettingsPage");
    const page = src("components/settings/pages/AppearancePage.tsx");
    for (const label of ["Clock", "Fullscreen", "Launch animation", "Start at login", "Shown on the rail", "Order"]) {
      expect(page.split(`agentExempt label="${label}"`).length - 1).toBe(1);
    }
    expect(page).toContain("Move up");
    expect(page).toContain("Move down");
  });
  test("b: nothing in Settings uses content-visibility or contain-intrinsic-size", () => {
    const walk = (d: URL): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(new URL(`${e.name}/`, d)) : [new URL(e.name, d).pathname]);
    for (const f of walk(pagesDir)) expect(readFileSync(f, "utf8")).not.toMatch(/content-visibility|contain-intrinsic/);
  });
  test("b+d: the shell page is not a scroller of its own", () => {
    const shell = src("components/settings/shell/SettingsPage.tsx");
    expect(shell).not.toMatch(/className="[^"]*overflow-y-auto/);
    expect(shell).toContain('closest<HTMLElement>("[data-settings-scroll]")');
  });
  test("c: the sections and the rail or aside are one group centred by the shell", () => {
    const shell = src("components/settings/shell/SettingsPage.tsx");
    expect(shell).toContain('data-settings-group className="mx-auto max-w-full" style={{ width: chips ? "100%" : wide || rail || aside || spacer ? SHELL_GROUP_WIDTH : SHELL_COLUMN }}');
  });
  test("d: Engines & usage has no fixed-height scroller", () => {
    for (const f of ["EnginesUsagePage.tsx", "GhAllowance.tsx"]) {
      const t = src(`components/settings/pages/${f}`);
      expect(t).not.toMatch(/overflow-y-(auto|scroll)|max-h-|maxHeight|h-screen|h-full/);
    }
  });
});
