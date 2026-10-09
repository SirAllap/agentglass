import { describe, expect, test } from "bun:test";
import { resolvePane } from "../src/lib/openSettings.ts";

const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();
const palette = await Bun.file(new URL("../src/components/CommandPalette.tsx", import.meta.url)).text();

const tabs = [...src.matchAll(/\{ id: "([a-z-]+)"(?: as const)?, label: "([^"]*)", group: "([^"]*)"/g)]
  .map((m) => ({ id: m[1]!, label: m[2]!, group: m[3]! }));
const order = /const TAB_GROUPS: TabGroup\[\] = \[([^\]]*)\]/.exec(src)?.[1]?.split(",").map((s) => s.trim().replace(/"/g, "")) ?? [];
const linkOnly = /const LINK_ONLY: Pane\[\] = \[([^\]]*)\]/.exec(src)?.[1]?.split(",").map((s) => s.trim().replace(/"/g, "")) ?? [];
const idsIn = (g: string) => tabs.filter((t) => t.group === g).map((t) => t.id);
function fn(name: string): string {
  const a = src.indexOf(`function ${name}(`);
  expect(a).toBeGreaterThan(-1);
  return src.slice(a, src.indexOf("\n}\n", a) + 3);
}

describe("slice 6 nav groups", () => {
  test("six groups, in this order", () => {
    expect(order).toEqual(["General", "Workspace", "Agents", "Library", "Connections", "System"]);
  });

  test("each group holds these pages, in this order", () => {
    expect(idsIn("General")).toEqual(["prefs", "appearance", "notifications", "rail", "keys"]);
    // browser is filed only where HAS_BROWSER; the test source has both spellings of one entry
    expect(idsIn("Workspace")).toEqual(["terminal", "diff", "browser", "tasks"]);
    expect(idsIn("Agents")).toEqual(["hooks", "lantern", "understudy", "budgets"]);
    expect(idsIn("Library")).toEqual(["recipes", "review-prompts", "saved-replies"]);
    expect(idsIn("Connections")).toEqual(["connections", "clickup", "remote", "plugins"]);
    expect(idsIn("System")).toEqual(["tmux", "privacy", "about"]);
  });

  test("every page is in the nav or declared link-only, never both", () => {
    const inNav = tabs.filter((t) => order.includes(t.group)).map((t) => t.id);
    const all = tabs.map((t) => t.id).filter((id) => id !== "onboarding");
    for (const id of all) expect(inNav.includes(id) || linkOnly.includes(id)).toBe(true);
    for (const id of linkOnly) expect(inNav.includes(id)).toBe(false);
  });

  test("Activity is link-only, and still renders when it is the pane", () => {
    expect(linkOnly).toEqual(["log"]);
    expect(src).toContain('{show("log") && <ActivityPane open={open} />}');
  });

  test("Activity is reachable from the palette and from Data & privacy", () => {
    expect(palette).toContain('label: "Activity log');
    expect(palette).toMatch(/openSettings\("log"\)/);
    expect(fn("PrivacyPane")).toContain('label="Activity log"');
    expect(fn("PrivacyPane")).toContain('openSettings("log")');
  });

  test("a remembered Activity page still restores", () => {
    expect(resolvePane("log")).toBe("log");
    expect(src).toContain("TABS.some((t) => t.id === at)");
  });

  test("the server log digest is a fold on About", () => {
    expect(fn("LogDigestSection")).toContain('<Fold label="Server log digest">');
  });
});
