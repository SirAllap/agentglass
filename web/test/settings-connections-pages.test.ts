/* The four Connections pages (Tasks, Jira, ClickUp, Remote & devices) are built on the shell. Static checks on their source. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasRail } from "../src/components/settings/shell/shellRules.ts";

const dir = join(import.meta.dir, "..", "src", "components", "settings", "pages");
const PAGES = ["TasksPage", "JiraPage", "ClickUpPage", "RemoteDevicesPage"] as const;
const src = Object.fromEntries(PAGES.map((p) => [p, readFileSync(join(dir, `${p}.tsx`), "utf8")])) as Record<(typeof PAGES)[number], string>;
const modal = readFileSync(join(import.meta.dir, "..", "src", "components", "SettingsModal.tsx"), "utf8");

describe("connections pages", () => {
  test("the modal routes each page id with one line and the old bodies are gone", () => {
    for (const line of ['<TasksPage c={pageCtx} folded={tasksFold} />', '<ClickUpPage />', '<JiraPage c={pageCtx} />', '<RemoteDevicesPage open={open} />'])
      expect(modal.split(line).length - 1, line).toBe(1);
    expect(modal).not.toContain("<RemoteAccessPane");
    expect(modal).not.toContain("<TasksSettingsPage");
  });
  test("every row has a kind; none is a bare label", () => {
    for (const p of PAGES) {
      const rows = src[p].match(/<SettingRow\b[^>]*?(?=\/>|>)/gs) ?? [];
      for (const r of rows) expect(/kind=/.test(r) || /kind=\{/.test(r), `${p}: ${r.slice(0, 60)}`).toBe(true);
      expect(src[p]).not.toMatch(/<(button|span|div)\b[^>]*\btitle=/);
    }
  });
  test("help is one sentence of 14 words at most", () => {
    for (const p of PAGES) for (const m of src[p].matchAll(/\bhelp="([^"]+)"/g)) {
      expect(m[1]!.trim().split(/\s+/).length, `${p}: ${m[1]}`).toBeLessThanOrEqual(14);
      expect(m[1], `${p}: ${m[1]}`).toMatch(/[.…]$/);
    }
  });
  test("each setting id is written from one page only", () => {
    const seen = new Map<string, string>();
    for (const p of PAGES) for (const m of src[p].matchAll(/setting\(("[A-Za-z.]+"|`[^`]+`)\)\.set/g)) {
      const id = m[1]!.replace(/["`]/g, "");
      expect(seen.get(id) ?? p, id).toBe(p);
      seen.set(id, p);
    }
    expect([...seen.keys()]).toEqual(expect.arrayContaining(["tasks.landing", "jira.syncFavourites", "jira.board.confirmMoves", "jira.statusUnits.counted"]));
  });
  test("Danger zone is last where a page has one, and the rail follows the 2-section rule", () => {
    const jira = src.JiraPage;
    expect(jira.indexOf('kind: "danger"')).toBeGreaterThan(jira.indexOf('id: "views"'));
    expect(hasRail(7)).toBe(true); // Jira: connection, steps, shows, board, views, (reviewers), danger
    expect(hasRail(2)).toBe(true); // Tasks
    expect(hasRail(1)).toBe(false); // a one-section page
    expect(src.RemoteDevicesPage.indexOf('{ id: "danger"')).toBeGreaterThan(src.RemoteDevicesPage.indexOf('{ id: "devices"'));
  });
});
