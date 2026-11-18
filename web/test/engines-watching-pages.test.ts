/* Engines & usage and Watching, rebuilt on the shell: routed, rail rule, row kinds, copy length, Danger zone last, no JSON for role engines. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasRail } from "../src/components/settings/shell/shellRules.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const modal = read("../src/components/SettingsModal.tsx");
const pages = {
  engines: read("../src/components/settings/pages/EnginesUsagePage.tsx"),
  watching: read("../src/components/settings/pages/WatchingPage.tsx"),
};
const sections = (s: string) => [...s.matchAll(/\{ id: "(\w+)", title: "[^"]+", kind: "(\w+)"/g)].map((m) => ({ id: m[1]!, kind: m[2]! }));

describe("routing", () => {
  test("one line each", () => {
    expect(modal).toContain('show("engines") && <EnginesUsagePage c={pageCtx} />');
    expect(modal).toContain('show("hooks") && <WatchingPage c={pageCtx} />');
  });
});

describe.each(Object.entries(pages))("%s page", (_n, src) => {
  test("no card rows, no title=, no Save button", () => {
    expect(src).not.toContain("SettingsCard");
    expect(src).not.toMatch(/<(div|button|span|a|input|Button)\b[^>]*\btitle=/);
    expect(src).not.toMatch(/>\s*Save\s*</);
  });
  test("help is one sentence of 14 words or fewer", () => {
    const helps = [...src.matchAll(/\bhelp="([^"]+)"/g)].map((m) => m[1]!);
    expect(helps.length).toBeGreaterThan(5);
    for (const h of helps) {
      expect(h.endsWith("."), h).toBe(true);
      expect(h.split(/\s+/).length, h).toBeLessThanOrEqual(14);
    }
  });
  test("row kinds are control, link or locked", () => {
    const kinds = [...src.matchAll(/<SettingRow kind="(\w+)"/g)].map((m) => m[1]!);
    expect(kinds.length).toBeGreaterThan(5);
    for (const k of kinds) expect(["control", "link", "locked"]).toContain(k);
  });
});

describe("page shapes", () => {
  test("Engines & usage: five sections, so the rail shows", () => {
    expect(hasRail(sections(pages.engines).length)).toBe(true);
  });
  test("Watching: Danger zone is last and holds the armed uninstall", () => {
    const s = sections(pages.watching);
    expect(s[s.length - 1]).toEqual({ id: "danger", kind: "danger" });
    expect(pages.watching).toContain("<DangerAction");
  });
  test("role engine and model are a Select pair per role, saved through the role route", () => {
    expect(pages.engines).toContain("api.workerRoleSave(");
    expect(pages.engines).not.toMatch(/JSON\.(parse|stringify)|<textarea/);
    expect((pages.engines.match(/<Select /g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  test("each store written once: watch settings, hooks, pace", () => {
    expect((pages.watching.match(/api\.lanternSettingsSave\(/g) ?? []).length).toBe(1);
    expect((pages.watching.match(/api\.hooksUninstall\(/g) ?? []).length).toBe(1);
    expect((pages.engines.match(/setPaceConfig\(/g) ?? []).length).toBe(1);
  });
});
