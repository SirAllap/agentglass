import { describe, expect, test } from "bun:test";
import { modalSource } from "./settingsSource.ts";
import { SETTINGS_PAGES } from "../src/lib/settingsRows.gen.ts";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();

describe("Polaris pull requests page", () => {
  test("is registered under Agents and rendered by the modal", async () => {
    const modal = modalSource();
    expect(modal).toContain('id: "polarisPrs", label: "Polaris pull requests", group: "Agents"');
    expect(await read("components/SettingsModal.tsx")).toContain('show("polarisPrs") && <PolarisPrsPage />');
    expect(SETTINGS_PAGES.some((p) => p.id === "polarisPrs")).toBe(true);
  });
  test("the page reuses the one list; the Agents screen shows it compact and links here", async () => {
    expect(await read("components/settings/pages/PolarisPrsPage.tsx")).toContain("<PullRequestsSection");
    expect(await read("components/agents/AgentsView.tsx")).toContain("<PullRequestsSection");
    expect(await read("components/agents/AgentsView.tsx")).toMatch(/PullRequestsSection[^\n]*compact/);
    expect(await read("components/polaris/PolarisSection.tsx")).toContain('openSettings("polarisPrs")');
  });
});
