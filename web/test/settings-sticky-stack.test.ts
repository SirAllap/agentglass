import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHEET_ROWS } from "../src/lib/layers.ts";

// What keeps the settings frame's sticky rows from painting over each other.
//
// Both heights are measured at run time (the index band wraps at some widths,
// the scope bar grows a line when a change is refused) and published as custom
// properties, and every offset that depends on them is a calc() over those
// properties. The tests below evaluate that CSS with heights standing in for
// the measurements and check the geometry the page ends up in: the band is the
// first pinned row, the bar pins below it, and a card scrolled to lands below
// both. They break when an offset is hand-stacked or a height is counted twice,
// which is the shape of the defect this file exists for.
const SRC = join(import.meta.dir, "..", "src");
const CSS = readFileSync(join(SRC, "index.css"), "utf8");
const BAND = readFileSync(join(SRC, "components/SettingsToc.tsx"), "utf8");
const BAR = readFileSync(join(SRC, "components/orchestration/ScopeBar.tsx"), "utf8");

/** The declarations of the first `selector { … }` at top level or inside a media block. */
function rule(css: string, selector: string): Record<string, string> {
  const at = css.search(new RegExp(`(?:^|[{}]|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`));
  expect({ selector, found: at > -1 }).toEqual({ selector, found: true });
  const open = css.indexOf("{", at);
  const body = css.slice(open + 1, css.indexOf("}", open));
  const out: Record<string, string> = {};
  for (const decl of body.split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}

/** The declarations of a rule inside the 1760px block: the rail layout. */
function wide(css: string, selector: string): Record<string, string> {
  const at = css.indexOf("@media (min-width: 1760px)");
  expect(at).toBeGreaterThan(-1);
  const body = css.slice(at, css.indexOf("\n}\n", at));
  return rule(`{${body}}`, selector);
}

/** var(--x, fallback) resolved to a number, with calc() arithmetic evaluated. */
function value(expr: string, vars: Record<string, number>): number {
  const expand = (s: string): string => {
    const at = s.indexOf("var(");
    if (at < 0) return s;
    let depth = 0, end = at + 3;
    for (; end < s.length; end++) {
      if (s[end] === "(") depth++;
      else if (s[end] === ")" && --depth === 0) break;
    }
    const inner = s.slice(at + 4, end);
    let split = -1, d = 0;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "(") d++;
      else if (inner[i] === ")") d--;
      else if (inner[i] === "," && d === 0) { split = i; break; }
    }
    const name = (split < 0 ? inner : inner.slice(0, split)).trim();
    const fallback = split < 0 ? "0" : inner.slice(split + 1);
    const replaced = name in vars ? String(vars[name]) : expand(fallback);
    return expand(s.slice(0, at) + replaced + s.slice(end + 1));
  };
  const tokens = expand(expr).replace(/calc\(/g, "(").replace(/px/g, "").match(/(\d*\.?\d+|[-+*/()])/g) ?? [];
  let i = 0;
  const atom = (): number => {
    const t = tokens[i++]!;
    if (t === "(") { const v = sum(); i++; return v; }
    if (t === "-") return -atom();
    if (t === "+") return atom();
    return Number(t);
  };
  const product = (): number => {
    let v = atom();
    while (tokens[i] === "*" || tokens[i] === "/") v = tokens[i++] === "*" ? v * atom() : v / atom();
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (tokens[i] === "+" || tokens[i] === "-") v = tokens[i++] === "+" ? v + product() : v - product();
    return v;
  };
  return sum();
}

/** The stack as the page declares it, with heights standing in for the measurements. */
const heights = (band: number, bar: number) => ({
  "--agx-stick-toc": band,
  "--orch-stick": bar,
  "--agx-settings-pad-top": 22,
});

const region = rule(CSS, ".agx-settings-scroll");
const regionWide = wide(CSS, ".agx-settings-scroll");
// The band is not drawn on every page (a search can name a page and match none
// of its rows), and the air under it is the band's, so its absence is a rule.
const bandless = rule(CSS, ".agx-settings-scroll:not(:has(.agx-toc))");
const bandRule = rule(CSS, ".agx-toc");
const airPaint = rule(CSS, ".agx-toc::after");
const rail = rule(`{${CSS.slice(CSS.indexOf("@media (min-width: 1760px)"))}}`, ".agx-settings-page > .agx-toc");
const barMargin = BAR.match(/marginTop: "([^"]+)"/)?.[1] ?? "";
const barTop = BAR.match(/top: "([^"]+)"/)?.[1] ?? "";
const preview = readFileSync(join(SRC, "components/settings/PreviewCard.tsx"), "utf8");
const previewTop = preview.match(/top: "([^"]+)"/)?.[1] ?? "";
const split = readFileSync(join(SRC, "components/settingsSplit.css"), "utf8");
const splitSide = [...split.matchAll(/\.agx-split-side \{([^}]*)\}/g)].map((m) => m[1]!).find((body) => body.includes("top:"))
  ?.match(/top: ([^;]+);/)?.[1] ?? "";
const railPaint = rule(CSS.slice(CSS.indexOf(".agx-settings-page > .agx-toc {")), ".agx-settings-page > .agx-toc::after");

/** The stack as the page declares it, with heights standing in for the measurements. */
function layout(band: number, bar: number, wideRail = false) {
  const decls = { ...region, ...(band === 0 ? bandless : {}), ...(wideRail ? regionWide : {}) };
  const vars: Record<string, number> = {
    ...heights(band, bar),
    "--agx-page-gap": value(rule(CSS, ".agx-settings-page")["--agx-page-gap"]!, {}),
  };
  // In dependency order, the way the stylesheet reads: the air, the band, the
  // bar's offset, then the stack the landing offset is measured from.
  for (const key of ["--agx-pin-gap", "--agx-band", "--agx-pin-top", "--agx-pin-stack"]) {
    if (decls[key]) vars[key] = value(decls[key]!, vars);
  }
  return {
    bandTop: value(bandRule.top!, vars),
    barTop: value(barTop, vars),
    // At rest the bar sits one page gap below the band's row, less its own margin.
    airAtRest: value(barMargin, vars) + vars["--agx-page-gap"]!,
    airPinned: vars["--agx-pin-top"]! - (wideRail ? 0 : band),
    landing: value(region["scroll-padding-top"]!, vars),
    gap: vars["--agx-pin-gap"]!,
    pinTop: vars["--agx-pin-top"]!,
    pinStack: vars["--agx-pin-stack"]!,
  };
}

describe("the settings frame's sticky stack is published once and derived", () => {
  test("the index band is never pushed down into the bar: it is the first pinned row", () => {
    for (const [band, bar] of [[64, 77], [29, 0], [96, 77]]) {
      const g = layout(band!, bar!);
      // A top greater than the band's resting offset is what moves the band down.
      expect({ band, bandTop: g.bandTop }).toEqual({ band, bandTop: 0 });
      expect(g.bandTop).toBeLessThan(22);
    }
  });

  test("the bar pins below the band, with the same air it has at rest", () => {
    for (const [band, bar] of [[64, 77], [29, 0], [96, 77]]) {
      const g = layout(band!, bar!);
      expect({ band, bar, air: g.airPinned }).toEqual({ band, bar, air: 12 });
      // At rest the two are the page's own gap apart; after a scroll they pin the
      // same distance apart, so the bar does not jump when it pins.
      expect({ band, bar, air: g.airAtRest }).toEqual({ band, bar, air: 12 });
      // And they never overlap in either state.
      expect(g.pinTop).toBeGreaterThanOrEqual(band!);
    }
  });

  test("a card scrolled to from the index lands below the bar, and below the band", () => {
    for (const [band, bar] of [[64, 77], [29, 0], [96, 77]]) {
      const g = layout(band!, bar!);
      // The landing offset counts the pinned stack once: band, air, bar, air.
      expect({ band, bar, landing: g.landing }).toEqual({ band, bar, landing: bar + band + 24 });
      // `--agx-pin-stack` is the bottom edge of the last pinned row.
      expect(g.landing - g.pinStack).toBe(12);
    }
  });

  test("with no band drawn, the bar pins at the region's edge and keeps no air", () => {
    const g = layout(0, 77);
    // Nothing is painted above the bar, so the bar's own top is the edge.
    expect(g.pinTop).toBe(0);
    expect(g.airPinned).toBe(0);
    // The landing offset counts the bar and its air, not a band that is absent.
    expect(g.pinStack).toBe(77);
    expect(g.landing).toBe(77 + 12);
  });

  test("from 1760px the band is a rail beside the cards, so it adds nothing above the bar", () => {
    const g = layout(258, 77, true);
    expect(g.pinTop).toBe(0);
    expect(g.barTop).toBe(0);
    expect(g.landing).toBe(77 + 12);
    const railTop = value(rail.top!, { "--agx-pin-top": g.pinTop });
    expect(railTop).toBe(16);
  });

  test("both pinned rows' z come from the layer table, and the band stays under the bar's air", () => {
    expect(SHEET_ROWS.band).toBeLessThan(SHEET_ROWS.bar);
    expect(BAND).toContain("zIndex: SHEET_ROWS.band");
    expect(BAR).toContain("zIndex: SHEET_ROWS.bar");
    expect(CSS).not.toMatch(/\.agx-toc \{[^}]*z-index/);
    expect(BAR).not.toContain("z-10");
  });

  test("each height is written by the element that owns it, and nowhere else", () => {
    expect(BAND).toContain('setProperty("--agx-stick-toc"');
    expect(BAR).toContain('setProperty("--orch-stick"');
    // The band's height reaches the offsets only through the published property.
    expect(CSS).not.toMatch(/--agx-toc-h/);
  });

  test("the region scrolls sideways rather than clipping what does not fit", () => {
    expect(region["overflow-x"]).toBe("auto");
    expect(region["overflow-y"]).toBe("auto");
  });

  test("the band paints the air it leaves under itself, so no card shows in the slot", () => {
    // Both rows stand on the page's own fill, one indirection from the theme.
    expect(CSS).toMatch(/--surface-page: var\(--bg\)/);
    expect(airPaint.background).toBe(bandRule.background);
    // A cover that does not take the point — a shadow, an unpainted box — is not one.
    expect("pointer-events" in airPaint).toBe(false);
    expect(airPaint.top).toBe("100%");
    for (const [band, bar] of [[29, 0], [29, 77], [64, 77], [96, 77]]) {
      const g = layout(band!, bar!);
      const painted = value(airPaint.height!, { "--agx-pin-gap": g.gap });
      // From the band's bottom edge to the bar's top edge, every point in the
      // slot answers the band, which is what `elementFromPoint` checks.
      expect({ band, bar, covered: band! + painted >= g.pinTop }).toEqual({ band, bar, covered: true });
      // And it stops at the bar rather than eating the row that pins under it.
      expect(band! + painted).toBeLessThanOrEqual(g.pinTop + 2);
    }
    // From 1760px the band is a rail beside the cards, and no row pins above the bar.
    expect(railPaint.content).toBe("none");
  });

  test("the preview column pins under the same stack as the page's other sticky column", () => {
    for (const [band, bar] of [[29, 0], [64, 77], [0, 77]]) {
      const g = layout(band!, bar!);
      const vars = { "--agx-pin-stack": g.pinStack, "--agx-pin-gap": g.gap };
      expect({ band, bar, top: value(previewTop, vars) }).toEqual({ band, bar, top: g.pinStack + g.gap });
      expect(value(previewTop, vars)).toBe(value(splitSide, vars));
    }
  });

  test("current is read under the last pinned row, not at the region's edge", () => {
    const look = BAND.slice(BAND.indexOf("const bar ="), BAND.indexOf("const tops"));
    // A page with no scope bar reads from the band's own bottom; the region's top
    // edge is behind the band, so it would name the card the band hides.
    expect(look).toContain('".agx-toc"');
    expect(look.indexOf('".agx-toc"')).toBeLessThan(look.indexOf("sc.getBoundingClientRect().top"));
  });

  test("Skip to the page lands on the scroller when the page has no control", () => {
    const nav = readFileSync(join(SRC, "components/SettingsNav.tsx"), "utf8");
    const modal = readFileSync(join(SRC, "components/SettingsModal.tsx"), "utf8");
    const skip = nav.slice(nav.indexOf("function skipToPage"), nav.indexOf("const LEGEND_WORD"));
    // The wrapper is a plain div: focus() on it is a no-op that leaves focus on the hidden link.
    expect(skip).toContain("[data-settings-scroll]");
    expect(skip).not.toMatch(/first \?\? main\)/);
    expect(modal).toMatch(/tabIndex=\{-1\} data-settings-scroll/);
  });
});
