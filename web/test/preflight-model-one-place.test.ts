/*
 * A model is chosen in one place. The Flight plan Settings tab shows the
 * Reviewer role's model and the way to Orchestration; it does not offer a
 * second picker of its own. Asserted against the source, because this project
 * has no renderer in its tests.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const source = await Bun.file(join(import.meta.dir, "../src/components/flightPlan/SettingsTab.tsx")).text();

describe("the Preflight model row", () => {
  test("sends the person to Orchestration", () => {
    expect(source).toContain('openSettings("orchestration")');
    expect(source).toContain("Change in Orchestration");
  });

  test("has no model picker of its own", () => {
    expect(source).not.toContain("onChange({ model:");
    expect(source).not.toContain('<select className="sel" aria-label="Model"');
  });

  test("says the engine and model are chosen once, in Orchestration", () => {
    expect(source).toContain("chosen once in Orchestration");
    expect(source).not.toContain("the model and the cap are this project's");
  });
});
