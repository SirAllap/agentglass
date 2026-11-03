/*
 * The mockup's icon set, held against the two lists that name it: every icon a
 * role may pick is drawn, the team agentglass ships picks only those, and a
 * role saved before the change still gets a glyph instead of the info one.
 */
import { describe, expect, test } from "bun:test";
import { FLOW_GLYPHS } from "../src/components/orchestration/flow/flowIcons.tsx";
import { FLOW_ICONS, FLOW_ICON_WAS, flowIconName, validateFlow } from "../../shared/flow.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";

describe("the role icons", () => {
  test("every name a role may pick is drawn", () => {
    expect(FLOW_ICONS.length).toBe(26);
    for (const name of FLOW_ICONS) expect(FLOW_GLYPHS[name]).toBeDefined();
  });

  test("the team agentglass ships picks icons it draws", () => {
    const f = templateFlow();
    for (const r of f.roster) {
      expect(FLOW_ICONS).toContain(r.ico as (typeof FLOW_ICONS)[number]);
      expect(FLOW_GLYPHS[r.ico]).toBeDefined();
    }
  });

  test("a role saved with an icon from before the mockup's set still reads", () => {
    for (const [was, now] of Object.entries(FLOW_ICON_WAS)) {
      expect(flowIconName(was)).toBe(now);
      expect(FLOW_GLYPHS[now]).toBeDefined();
      expect(FLOW_GLYPHS[now]).not.toBe(FLOW_GLYPHS.info);
    }
    const f = templateFlow();
    f.roster = f.roster.map((r, i) => (i === 0 ? { ...r, ico: "compass" } : r));
    const v = validateFlow(f);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.roster[0]!.ico).toBe("chart");
  });
});
