// The bottom row repeated what the QUOTA tile and the top-bar chips say, and the orrery drew a box
// around a focused working body. Source is asserted against source: there is no renderer here.
import { describe, expect, test } from "bun:test";
import { quotaTipLines } from "../src/lib/starboardKpi.ts";
import type { ProviderUsage } from "../../shared/types.ts";

const view = await Bun.file(new URL("../src/components/StarboardView.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();

describe("Starboard quota panel", () => {
  test("is not drawn; the tile's tip carries per-provider quota", () => {
    expect(view).not.toContain("<UsageBox");
    expect(view).not.toContain('data-glyph="quota"');
    expect(view).toContain("sbQuotaTip(quotaTipLines(quotaRows))");
  });
  test("the bottom row has no rule for a third child, and no 2300 px two-column layout", () => {
    expect(css).not.toMatch(/\.sb-bot > :nth-child\(3\)/);
    expect(css).not.toMatch(/@container sb \(min-width: 2300px\) \{ \.sb-bot/);
  });
  test("one row per provider with a reading, and OpenCode says its numbers are this PC's", () => {
    const rows = [
      { provider: "anthropic", label: "Claude", available: true, windows: [{ minutes: 300, usedPercent: 12.4, resetsAt: null }, { minutes: 10080, usedPercent: 30, resetsAt: null }] },
      { provider: "opencode", label: "OpenCode Go", available: true, source: "this PC", windows: [{ minutes: 300, usedPercent: 1, resetsAt: null }, { minutes: 10080, usedPercent: 0, resetsAt: null }, { minutes: 43200, usedPercent: 0, resetsAt: null }] },
      { provider: "codex", label: "Codex", available: false, windows: [] },
    ] as unknown as ProviderUsage[];
    expect(quotaTipLines(rows)).toEqual([
      { label: "Claude", windows: "5 h 12% · week 30%" },
      { label: "OpenCode Go · this PC only", windows: "5 h 1% · week 0% · 30 d 0%" },
    ]);
    expect(quotaTipLines(null)).toEqual([]);
  });
});

describe("Orrery focus box", () => {
  test("a body draws no outline in any focus state: a click gives :focus without :focus-visible, and the browser's SVG `:focus { outline: auto }` rings it", () => {
    expect(css).toContain(".sb .sb-body[data-tip] { outline: none !important; }");
    expect(css).not.toMatch(/\.sb-body\[data-tip\]:focus-visible \{ outline: none/);
  });
  test("a fresh console reading is the OpenCode line, not the local count", () => {
    const w = (minutes: number, usedPercent: number) => ({ id: String(minutes), label: "w", minutes, usedPercent, resetsAt: null });
    const rows = [{
      provider: "opencode", label: "OpenCode Go", available: true, source: "this PC", usageKey: true,
      windows: [w(300, 14), w(10080, 20), w(43200, 10)],
      calibration: { at: Date.now() - 60_000, windows: [w(300, 34), w(10080, 53), w(43200, 26)] },
    }] as unknown as ProviderUsage[];
    expect(quotaTipLines(rows)).toEqual([{ label: "OpenCode Go", windows: "5 h 34% · week 53% · 30 d 26%" }]);
  });
});
