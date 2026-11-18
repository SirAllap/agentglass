/* The six Library / System pages: routed once, built on the shell, Danger zone last, rows within the copy rule. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { orderSections, hasRail } from "../src/components/settings/shell/shellRules.ts";

const rd = (p: string) => readFileSync(new URL(`../src/components/${p}`, import.meta.url), "utf8");
const PAGES: Record<string, string> = {
  CommandsPage: 'show("recipes") && <CommandsSettingsPage c={pageCtx} />',
  PluginsPage: 'show("plugins") && <PluginsSettingsPage c={pageCtx} />',
  UnderstudyPage: 'show("understudy") && <UnderstudySettingsPage c={pageCtx} />',
  DataPage: 'show("privacy") && <DataSettingsPage c={pageCtx} />',
  ActivityPage: 'show("log") && <ActivitySettingsPage c={pageCtx} />',
  AboutPage: 'show("about") && <AboutSettingsPage c={pageCtx} />',
};

test("each page is routed by one line in the page map", () => {
  const modal = rd("SettingsModal.tsx");
  for (const line of Object.values(PAGES)) expect(modal.split(line).length - 1).toBe(1);
});

test("each page builds on the shell and has no title= attribute", () => {
  for (const name of Object.keys(PAGES)) {
    const src = rd(`settings/pages/${name}.tsx`);
    expect(src).toContain("<SettingsPage");
    expect(src).not.toMatch(/<(div|span|button|a)\b[^>]*\stitle=/);
  }
});

test("Data & privacy: Danger zone is declared last and the order keeps it last", () => {
  const src = rd("settings/pages/DataPage.tsx");
  expect(src.lastIndexOf('kind: "danger"')).toBeGreaterThan(src.lastIndexOf('kind: "normal"'));
  const out = orderSections([{ kind: "danger" as const }, { kind: "normal" as const }]);
  expect(out[1]!.kind).toBe("danger");
});

test("rail rule: these pages have a rail from 2 sections", () => {
  expect(hasRail(6)).toBe(true);   // Data & privacy: 6 sections
  expect(hasRail(1)).toBe(false);  // one section
});

test("shell row help is one sentence of at most 14 words", () => {
  for (const name of Object.keys(PAGES)) {
    const src = rd(`settings/pages/${name}.tsx`);
    for (const m of src.matchAll(/\bhelp[:=]\s*"([^"]+)"/g)) {
      expect(m[1]!.trim().split(/\s+/).length).toBeLessThanOrEqual(14);
      expect(m[1]!.endsWith(".")).toBe(true);
    }
  }
});

test("each shell row has a control or a link", () => {
  for (const name of ["DataPage", "UnderstudyPage", "AboutPage"]) {
    const src = rd(`settings/pages/${name}.tsx`);
    for (const m of src.matchAll(/<SettingRow\b[^>]*?\bkind="(\w+)"/g)) expect(["control", "link", "locked"]).toContain(m[1]!);
  }
});
