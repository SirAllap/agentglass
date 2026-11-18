/*
 * The Workers page on the new shell: every row from ia.md once, a control or a link on each,
 * Danger zone last, the rail rule, and the copy rule (one sentence, 14 words at most).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasRail, orderSections } from "../src/components/settings/shell/shellRules.ts";
import { SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";

const SRC = readFileSync(new URL("../src/components/settings/pages/WorkersPage.tsx", import.meta.url).pathname, "utf8");
const ROWS = ["Workers at once", "Minutes per turn", "Review rounds", "Memory one worker may hold", "Roles in this project", "Role engines", "What a worker may do", "Retries with the next engine", "Forget worker roles"];

describe("Workers page", () => {
  test("each ia.md row is drawn once in the page file", () => {
    for (const label of ROWS) expect([...SRC.matchAll(new RegExp(`<SettingRow[^>]*?label="${label}"`, "gs"))].length).toBe(1);
  });
  test("each row is indexed once on the workers pane", () => {
    for (const label of ROWS) expect(SETTINGS_ROWS.filter((r) => r.pane === "workers" && r.label === label).length).toBe(1);
  });
  test("every row is a control, a link or a locked row; no fact row", () => {
    expect(SRC).not.toContain('kind="fact"');
    expect(SRC).not.toMatch(/<(div|span|button|input)\b[^>]*\btitle=/);
  });
  test("every id stays: memory and review rounds keep their registry id", () => {
    expect(SRC).toContain('settingId="workers.memoryMax"');
    expect(SRC).toContain('settingId="orchestration.review.rounds"');
  });
  test("Danger zone is last, whatever the declared order", () => {
    const kinds = orderSections([{ kind: "danger" as const }, { kind: "more" as const }, { kind: "normal" as const }]).map((s) => s.kind);
    expect(kinds).toEqual(["normal", "more", "danger"]);
  });
  test("rail rule: one section has no rail, two have it", () => {
    expect(hasRail(1)).toBe(false);
    expect(hasRail(2)).toBe(true);
  });
  test("help copy is one sentence of 14 words at most", () => {
    const helps = [...SRC.matchAll(/\bhelp="([^"]+)"/g)].map((m) => m[1]!);
    expect(helps.length).toBeGreaterThanOrEqual(8);
    for (const h of helps) {
      expect(h.split(/\s+/).length).toBeLessThanOrEqual(14);
      expect(h.endsWith(".")).toBe(true);
      expect(h.slice(0, -1)).not.toContain(". ");
    }
  });
});
