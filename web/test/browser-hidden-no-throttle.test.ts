import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("a hidden browser view stops painting but keeps running", () => {
  test("guests are never throttled: guard forces it off and nothing turns it on", () => {
    expect(read("../../electron/guest-guard.js")).toContain("webPreferences.backgroundThrottling = false;");
    for (const f of ["../../electron/main.js", "../../electron/preload.js", "../src/lib/desktop.ts", "../src/components/BrowserPanel.tsx"]) {
      expect(read(f)).not.toMatch(/setBackgroundThrottling\(\s*(true|!)/);
    }
  });
  test("background tabs are hidden with visibility, never unmounted or display:none", () => {
    const panel = read("../src/components/BrowserPanel.tsx");
    expect(panel).toContain('visibility: "hidden" as const');
    expect(panel).not.toMatch(/<webview[^>]*display:\s*"none"/);
  });
});
