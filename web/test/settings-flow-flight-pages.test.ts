/*
 * Flow & review and Flight plan on the new shell: each stored row once, one sentence of help
 * (14 words at most), and each row reachable in the generated index on its own pane.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";

const page = (n: string) => readFileSync(new URL(`../src/components/settings/pages/${n}.tsx`, import.meta.url).pathname, "utf8");
const entries = (src: string) => [...src.matchAll(/\{ id: "([^"]+)",[^\n]*?label: "([^"]+)", help: "([^"]+)"/g)].map((m) => ({ id: m[1]!, label: m[2]!, help: m[3]! }));

for (const [file, pane] of [["FlowReviewPage", "orchestration"], ["FlightPlanPage", "fplan"]] as const) {
  describe(`${file}`, () => {
    const rows = entries(page(file));
    test("has rows, each id once", () => {
      expect(rows.length).toBeGreaterThan(5);
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    });
    test("help is one sentence of 14 words at most", () => {
      for (const r of rows) {
        expect(r.help.split(/\s+/).length, r.id).toBeLessThanOrEqual(14);
        expect(r.help.endsWith("."), r.id).toBe(true);
      }
    });
    test(`each row is indexed once on ${pane}`, () => {
      // The polaris.* rows are drawn by the Polaris page (PolarisPage lists POLARIS from FlowReviewPage), so the index files them there.
      for (const r of rows) expect(SETTINGS_ROWS.filter((x) => x.pane === (r.id.startsWith("polaris.") ? "polaris" : pane) && x.settingId === r.id).length, r.id).toBe(1);
    });
  });
}
