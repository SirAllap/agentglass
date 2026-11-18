/*
 * The rebuilt Permissions page: routed by one line, built on the shell, every
 * row a control or a link, copy within the rule, Danger zone absent (nothing
 * here is destructive) and the rail present by the 5-sections rule.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasRail } from "../src/components/settings/shell/shellRules.ts";

const page = readFileSync(new URL("../src/components/settings/pages/PermissionsPage.tsx", import.meta.url), "utf8");
const modal = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");

const sectionIds = [...page.matchAll(/\{ id: "(\w+)", title: "[^"]+", kind: "(\w+)"/g)].map((m) => ({ id: m[1]!, kind: m[2]! }));
const rows = [...page.matchAll(/<SettingRow kind="(\w+)"([^>]*?)\blabel=(?:\{([^}]+)\}|"([^"]+)")/g)];

describe("PermissionsPage", () => {
  test("routed from the modal with one line", () => {
    expect(modal).toContain('show("perm") && <PermissionsPage c={pageCtx} />');
  });
  test("eight sections (the worker level section embeds the old Flow part until it has shell rows), so the rail shows, and no Danger zone", () => {
    expect(sectionIds.length).toBe(8);
    expect(hasRail(sectionIds.length)).toBe(true);
    expect(sectionIds.some((s) => s.kind === "danger")).toBe(false);
  });
  test("every row is a control, locked or link row (no raw card rows)", () => {
    expect(page).not.toContain("SettingsCard");
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) expect(["control", "link", "locked"]).toContain(r[1]!);
  });
  test("every row's help is one sentence of 14 words or fewer, ending in a full stop", () => {
    const helps = [...page.matchAll(/\bhelp="([^"]+)"/g)].map((m) => m[1]!);
    expect(helps.length).toBeGreaterThan(20);
    for (const h of helps) {
      expect(h.endsWith("."), h).toBe(true);
      expect(h.split(/\s+/).length, h).toBeLessThanOrEqual(14);
      expect(h.slice(0, -1).includes(". "), h).toBe(false);
    }
  });
  test("no title= attribute and no Save button", () => {
    expect(page).not.toMatch(/<Button[^>]*\btitle=/);
    expect(page).not.toMatch(/>\s*Save\s*</);
  });
  test("each setting id is written from one place", () => {
    for (const id of ["agents.changeWithoutAsking", "flow.agentEdit", "browser.workers", "browser.workerVerbs", "browser.origins.allow", "browser.profiles.allow"]) {
      expect((page.match(new RegExp(`"${id.replace(/\./g, "\\.")}"`, "g")) ?? []).length, id).toBeGreaterThan(0);
    }
    expect((page.match(/api\.hooksGate\(/g) ?? []).length).toBe(1);
    expect((page.match(/api\.jiraWrites\(/g) ?? []).length).toBe(1);
    expect((page.match(/api\.clickupSetWrites\(/g) ?? []).length).toBe(1);
  });
});
