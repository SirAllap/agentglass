// The bottom row repeated what the QUOTA tile and the top-bar chips say, and the orrery drew a box
// around a focused working body. Source is asserted against source: there is no renderer here.
import { describe, expect, test } from "bun:test";
import { quotaLines } from "../src/lib/starboardKpi.ts";
import type { ProviderUsage } from "../../shared/types.ts";

const view = await Bun.file(new URL("../src/components/StarboardView.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();

describe("Starboard quota panel", () => {
  test("is not drawn; the tile's tip carries per-provider quota", () => {
    expect(view).not.toContain("<UsageBox");
    expect(view).not.toContain('data-glyph="quota"');
    expect(view).toContain("sbQuotaTip(quotaLines(quotaRows))");
  });
  test("the bottom row has no rule for a third child, and no 2300 px two-column layout", () => {
    expect(css).not.toMatch(/\.sb-bot > :nth-child\(3\)/);
    expect(css).not.toMatch(/@container sb \(min-width: 2300px\) \{ \.sb-bot/);
  });
  test("quotaLines: one line per provider with a reading", () => {
    const rows = [
      { provider: "anthropic", label: "Claude", available: true, windows: [{ minutes: 300, usedPercent: 12.4, resetsAt: null }, { minutes: 10080, usedPercent: 30, resetsAt: null }] },
      { provider: "codex", label: "Codex", available: false, windows: [] },
    ] as unknown as ProviderUsage[];
    expect(quotaLines(rows)).toEqual(["Claude · 5 h 12% · week 30%"]);
    expect(quotaLines(null)).toEqual([]);
  });
});

describe("Orrery focus box", () => {
  test("a focused body draws no outline of its own: the generic [data-tip] ring is out-ranked", () => {
    expect(css).toContain(".sb .sb-body[data-tip]:focus-visible { outline: none; }");
  });
});
