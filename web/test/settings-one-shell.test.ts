import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("one page shell", () => {
  test("SettingsModal never renders SettingsToc and the old file is gone", () => {
    const modal = src("components/SettingsModal.tsx");
    expect(modal).not.toContain("SettingsToc");
    expect(modal).not.toContain("NO_TOC");
    expect(() => src("components/SettingsToc.tsx")).toThrow();
  });
  test("every pane component the modal draws renders through SettingsPage", () => {
    const modal = src("components/SettingsModal.tsx");
    const ToolsPane = modal.slice(modal.indexOf("function ToolsPane"), modal.indexOf("function ToolsPane") + 2500);
    expect(ToolsPane).toContain("<PageShell");
    expect(src("components/orchestration/GapsPane.tsx")).toContain("<SettingsPage");
    const files = ["Appearance", "Terminal", "Diffs", "Tasks", "Data", "Commands", "Notifications", "Browser", "Shortcuts", "Git", "EnginesUsage", "Watching", "Jira", "RemoteDevices", "Plugins", "Activity", "Understudy", "Files", "Permissions", "Workers", "FlightPlan", "About", "Polaris"];
    for (const f of files) expect(src(`components/settings/pages/${f}Page.tsx`)).toContain("<SettingsPage");
    expect(src("components/settings/pages/ClickUpPage.tsx")).toContain("<SettingsPage");
    expect(src("components/settings/pages/advanced.tsx")).toContain("<SettingsPage");
    expect(src("components/settings/pages/inspect.tsx")).toContain("<SettingsPage");
    expect(src("components/settings/pages/later.tsx")).toContain("<SettingsPage");
    expect(src("components/orchestration/OrchestrationPane.tsx")).toContain("<FlowReviewPage");
  });
});
