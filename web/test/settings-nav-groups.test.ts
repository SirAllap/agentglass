import { describe, expect, test } from "bun:test";
import { modalSource } from "./settingsSource.ts";
import { resolvePane } from "../src/lib/openSettings.ts";
import { SETTINGS_TREE_PAGES as NEW_PAGES } from "../../shared/uiActions.ts";
import { NAV_GROUPS, SYSTEM_GROUP } from "../src/lib/settingsNav.ts";

const src = modalSource();
const palette = await Bun.file(new URL("../src/components/CommandPalette.tsx", import.meta.url)).text();

const tabs = [...src.matchAll(/\{ id: "([A-Za-z-]+)"(?: as const)?, label: "([^"]*)", group: "([^"]*)"/g)]
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

  test("each group holds these pages, in this order (one level, no repeated name)", () => {
    const nav = (g: string) => NEW_PAGES.filter((id) => idsIn(g).includes(id));
    expect(nav("General")).toEqual(["appearance", "notifications", "keys"]);
    expect(nav("Workspace")).toEqual(["terminal", "finder", "diff", "browser", "git"]);
    expect(nav("Agents")).toEqual(["perm", "engines", "orchestration", "polaris", "polarisPrs", "workers", "fplan", "hooks"]);
    expect(nav("Library")).toEqual(["recipes", "plugins", "understudy"]);
    expect(nav("Connections")).toEqual(["tasks", "jira", "clickup", "remote"]);
    expect(nav("System")).toEqual(["privacy", "log", "about"]);
    expect(nav("Advanced")).toEqual(["advanced", "inspect"]);
    // every nav entry is a page of the new tree, and nothing else is in a group
    expect(tabs.filter((t) => t.group !== "").map((t) => t.id).sort()).toEqual([...NEW_PAGES].sort());
    const labels = tabs.filter((t) => t.group !== "").map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("the shell's group metadata is the same six names, in the same order", () => {
    expect([...NAV_GROUPS.map((g) => g.name as string), SYSTEM_GROUP.name]).toEqual(order);
  });

  test("every page is in the nav, folded into one, or declared link-only", () => {
    const inNav = tabs.filter((t) => order.includes(t.group) || t.group === "Advanced").map((t) => t.id);
    const folded = tabs.filter((t) => t.group === "").map((t) => t.id).filter((id) => !linkOnly.includes(id));
    for (const id of folded) expect(resolvePane(id) !== id && inNav.includes(resolvePane(id)), id).toBe(true);
    for (const id of linkOnly) expect(inNav.includes(id)).toBe(false);
  });

  test("Gaps and additions is out of the nav, link-only, and still renders when it is the pane", () => {
    expect(linkOnly).toEqual(["gaps"]);
    expect(src).toContain('{show("gaps") && <GapsPane />}');
  });

  test("Activity is a System page now, and still renders when it is the pane", () => {
    expect(idsIn("System")).toContain("log");
    expect(src).toContain("function ActivitySettingsPage");
    expect(src).toMatch(/show\("log"\) && \(/);
  });

  test("the nav is the approved one: 28 pages, each in one group, no sub-labels", () => {
    const inNav = tabs.filter((t) => t.group !== "");
    expect(inNav.length).toBe(28);
    expect(new Set(inNav.map((t) => t.id)).size).toBe(28);
    expect(src).not.toMatch(/ sub: "/);
  });

  test("every old page id, and the id the approved mockup uses, still lands on a page", () => {
    const ids = new Set(tabs.map((t) => t.id as string));
    for (const old of ["hooks", "tmux", "understudy", "rail", "budgets", "lantern", "log", "onboarding", "gaps", "open", "export",
      "prefs", "notifications", "orchestration", "recipes", "review-prompts", "saved-replies", "connections", "privacy"]) {
      expect(ids.has(resolvePane(old)), old).toBe(true);
    }
    for (const mock of ["window", "notif", "sidebar", "engine", "usage", "flow", "cmds", "review", "replies", "services", "data", "activity", "under", "setup"]) {
      expect(ids.has(resolvePane(mock)), mock).toBe(true);
    }
    expect(resolvePane("lantern")).toBe("hooks");
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
    expect(resolvePane("log")).toBe("log");
  });

  test("the server log digest is a fold on About", () => {
    expect(fn("LogDigestSection")).toContain("fold={{ open, onToggle: setOpen }}");
  });
});
