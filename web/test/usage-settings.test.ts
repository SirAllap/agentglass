/*
 * The Usage & budgets page, where the gear in the plan panel lands.
 *
 * Three things were wrong there for the owner: no OpenCode Go section, a Codex
 * card for a provider he does not use, and no way to choose the bar's chips
 * except from the bar itself. The decisions are asserted from the page's own
 * source, the way every other "which card shows" rule in this project is.
 */
import { describe, expect, test } from "bun:test";
import { modalSource } from "./settingsSource.ts";
import { readFileSync } from "node:fs";

const page = modalSource();
const card = readFileSync(new URL("../src/components/engines/UsageKeyCard.tsx", import.meta.url), "utf8");

describe("Usage & budgets", () => {
  test("has an OpenCode Go card with the key, a numbered guide, the console and the last reading", () => {
    expect(page).toContain("<OpenCodeGoCard />");
    expect(card).toContain("USAGE_KEY_STEPS");
    expect(card).toContain("How to create the key");
    expect(card).toContain("Read the console now");
    expect(card).toContain('label="Last reading"');
    expect(card).toContain("keyStatusChip(set, row)");
    expect(card).toContain("lastReading(row)");
  });

  test("has one Usage bar switch per provider, on the agent-changeable setting", () => {
    for (const p of ["anthropic", "codex", "opencode"]) {
      // The Engines & usage page draws the four rows from one table; each row carries its id.
      expect(page).toContain(`setting("usage.bar.${p}").set(`);
    }
    expect(page).toContain("settingId={`usage.bar.${b.id}`}");
    expect(page).toContain('title="Usage bar"');
  });

  test("the Codex card shows only after Codex has had a reading here", () => {
    expect(page).toContain('everSeen("codex")');
    // The Engines & usage page says the cost in its one-line help (copy rule), not in a fold.
    expect(page).toContain("Runs one small turn each hour, which spends a little quota.");
  });
});
