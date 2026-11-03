import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHEET_ROWS } from "../src/lib/layers.ts";

// The Settings frame owns the page's only scrollbar. The header is outside the
// scroll region, so it cannot drift and nothing can paint behind it; every page
// drawn inside the frame is content of that one region. A page that brought its
// own scroller would put a second bar beside the frame's and move the header
// with it, which is the defect this test exists to keep out.
const SRC = join(import.meta.dir, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const MODAL = read("components/SettingsModal.tsx");
const CSS = read("index.css");

/** Every page the frame draws, including the pages SettingsModal itself renders
 *  inline and the sheet raised over Orchestration. Listed by module so a new
 *  page has to be added here. */
const PAGES = [
  "components/RecipesPane.tsx",
  "components/ReviewPromptsPane.tsx",
  "components/SavedRepliesPane.tsx",
  "components/ClickUpPane.tsx",
  "components/JiraPane.tsx",
  "components/RemoteAccessPane.tsx",
  "components/PluginsPane.tsx",
  "components/BudgetsPane.tsx",
  "components/engines/EnginesPane.tsx",
  "components/CleanupSettings.tsx",
  "components/orchestration/OrchestrationPane.tsx",
  "components/SettingsModal.tsx",
  "components/orchestration/RuleForm.tsx",
];

/** Boxes inside a page that scroll on purpose: how many, and what they scroll. */
const INNER_SCROLLERS: Array<{ file: string; count: number; why: string }> = [
  { file: "components/SettingsModal.tsx", count: 2, why: "two project pickers, each capped at 220px, scroll their own list" },
  { file: "components/orchestration/RuleForm.tsx", count: 1, why: "the rule sheet's body scrolls inside the dialog raised over the page" },
];

/** Stylesheets the pages import. */
const PAGE_CSS = [
  "components/settingsSplit.css",
  "components/settingsGroupB.css",
  "components/orchestration/orchestration.css",
  "components/cleanupSettings.css",
];

/** Class rules in those stylesheets that scroll a box on purpose, never the page. */
const CSS_SCROLLERS: Array<{ file: string; rule: string; why: string }> = [
  { file: "components/cleanupSettings.css", rule: ".agx-cl-rows", why: "the project list beside Git and pull requests, capped by .agx-cl-list's max-height" },
  { file: "components/orchestration/orchestration.css", rule: ".agx-flow-preset-file", why: "the preset file preview is capped at 220px and scrolls its own text, never the page" },
];

/* Every way a box in this project is told to scroll VERTICALLY: Tailwind's
   classes (price both axes and the y axis), an inline style, and the same in a
   stylesheet. A page's second scrollbar does not care which of them was used;
   a sideways one on a code block is not that bar and is left alone. */
const scrolls = /(?:^|["'`\s])(?:overflow-(?:auto|scroll)|overflow-y-(?:auto|scroll)|overflowY:\s*["']?(?:auto|scroll)|overflow:\s*["']?(?:auto|scroll))/g;
const cssScrollerRules = (css: string) =>
  [...css.matchAll(/([^{}]+)\{[^{}]*overflow(?:-y)?:\s*(?:auto|scroll)/g)].map((m) => m[1]!.trim());

/** Every rule in the frame's own stylesheet, selector and body. */
const cssRules = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
/** Rules that reach inside the frame, where a page is drawn. */
const IN_FRAME = /\.(?:agx-settings|agx-toc|agx-ph|agx-scard|agx-sp|agx-sn)\b/;
/** Selectors only: the prose above a rule is not part of it. */
const CALC_CSS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the settings frame owns the page's one scroll region", () => {
  test("the header is drawn before — and outside — the element that scrolls", () => {
    const scroller = MODAL.indexOf("data-settings-scroll");
    expect(scroller).toBeGreaterThan(-1);
    expect(MODAL.indexOf("<SettingsPageHeader")).toBeGreaterThan(-1);
    expect(MODAL.indexOf("<SettingsPageHeader")).toBeLessThan(scroller);
    // One region: a second one would be a second bar.
    expect(MODAL.split("data-settings-scroll").length - 1).toBe(1);
    expect(MODAL).toMatch(/className="agx-settings-scroll[^"]*"/);
  });

  test("the frame's column is a flex box, not a scroller", () => {
    const rule = CSS.match(/\.agx-settings-main\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("display: flex");
    expect(rule).not.toContain("overflow-y");
  });

  test("the one region has the theme's scrollbar and a stable gutter, so a short page does not shift", () => {
    const rule = CSS.match(/\.agx-settings-scroll\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("overflow-y: auto");
    expect(rule).toContain("scrollbar-gutter: stable");
    expect(rule).toContain("min-height: 0");
  });

  test("an anchor or the browser's own focus scroll stops under the pinned rows, not at the region's edge", () => {
    const rule = CSS.match(/\.agx-settings-scroll\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/scroll-padding-top: calc\(var\(--agx-pin-stack\) \+ var\(--agx-pin-gap\)\)/);
    // One offset: a card that carried its own would be counted twice.
    expect(CSS).not.toMatch(/scroll-margin-top/);
    expect(read("components/SettingsToc.tsx")).toContain("scrollIntoView");
  });

  test("nothing scrolls inside a page: the frame's region is the only one", () => {
    for (const file of PAGES) {
      const allowed = INNER_SCROLLERS.find((s) => s.file === file)?.count ?? 0;
      const found = (read(file).match(scrolls) ?? []).length;
      expect({ file, scrollers: found }).toEqual({ file, scrollers: allowed });
    }
  });

  test("the frame's own stylesheet adds no scroller inside the frame but the search list", () => {
    const found = cssRules(CALC_CSS)
      .filter((r) => IN_FRAME.test(r.sel) && /overflow(?:-y)?:\s*(?:auto|scroll)/.test(r.body))
      .map((r) => r.sel);
    // The region itself, and the search results list, which is capped by its popover.
    expect(found.sort()).toEqual([".agx-settings-scroll", ".agx-sp-list"]);
  });

  test("no page stylesheet starts a page scroller: the one it declares is a capped inner list", () => {
    for (const file of PAGE_CSS) {
      const allowed = CSS_SCROLLERS.filter((s) => s.file === file).map((s) => s.rule);
      expect({ file, rules: cssScrollerRules(read(file)) }).toEqual({ file, rules: allowed });
    }
  });

  test("the header is opaque: no tone mixed toward transparent, no blur", () => {
    const rule = CSS.match(/\.agx-ph\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("background: var(--surface-page)");
    expect(rule).not.toContain("transparent");
    expect(rule).not.toContain("backdrop-filter");
  });

  test("the sticky index band is opaque, and the rail drops the fill it does not need", () => {
    const base = CSS.match(/\.agx-toc\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(base).toContain("background: var(--surface-page)");
    const railBlock = CSS.slice(CSS.indexOf("@media (min-width: 1760px)"));
    const rail = railBlock.match(/\.agx-settings-page > \.agx-toc\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rail).toContain("background: none");
    expect(rail).toContain("top: calc(var(--agx-pin-top, 0px) + 16px)");
  });

  test("the suppressed ring is suppressed on the element the frame focuses", () => {
    expect(CSS).toMatch(/\.agx-settings-scroll:focus\s*\{[^}]*outline:\s*none/);
    expect(CSS).not.toContain(".agx-settings-main:focus");
  });

  test("the flight-plan chip rides in the scope bar's one row, not above it", () => {
    const pane = read("components/orchestration/OrchestrationPane.tsx");
    const bar = pane.indexOf("<ScopeBar");
    expect(bar).toBeGreaterThan(-1);
    // Handed to the bar, so it shares the bar's row; drawn beside the bar it was
    // a second pinned row.
    expect(pane.slice(bar, pane.indexOf("/>", bar))).toContain("lead={p.lead}");
    expect(pane).not.toMatch(/^\s*\{p\.lead\}/m);
    expect(MODAL).toContain("lead={<FlightPlanLink");
  });
});

/** The body of the first rule whose selector is exactly this. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return "";
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("the Flow page fills the frame's one region instead of a viewport calculation", () => {
  const ORCH = read("components/orchestration/orchestration.css");
  const POLARIS = read("components/polaris/polarisView.css");

  test("no orphan header variable and no viewport height: the box comes from the frame", () => {
    // `--agx-ph-h` was written nowhere while the header was 137px: the page was
    // sized against a guess and the frame scrolled a second time.
    expect(ORCH).not.toContain("--agx-ph-h");
    expect(POLARIS).not.toContain("--agx-ph-h");
    const flow = ruleBody(ORCH, ".agx-orch.agx-flow");
    expect(flow).toContain("height: 100%");
    expect(flow).not.toMatch(/100(?:d|s|l)?vh/);
  });

  test("a short window hands the page to the frame's region instead of a 78px section", () => {
    const flow = ruleBody(ORCH, ".agx-orch.agx-flow");
    const cfg = ruleBody(ORCH, ".agx-flow-cfg");
    // A fixed box that clips what it cannot fit squeezed the pane to 0 at
    // 1280x620, with nothing scrolling anywhere.
    expect(flow).not.toContain("overflow: hidden");
    expect(ORCH).not.toMatch(/min-height:\s*\d{3}px/);
    // At every height the section is as tall as its content: no floor, and no scroller of its own.
    expect(cfg).toContain("min-height: 0");
    expect(cfg).toContain("flex: none");
    // Below it there is no floor at all: measured at 640x360 before this rule,
    // the section was 78px of a 1691px scroller while the frame's region also
    // scrolled. The page is then as tall as its content and nothing inside it
    // scrolls. See settings-pinned-bands.test.ts for the rule itself.
  });

  test("the page wrapper and its content chain pass the frame's measured height down", () => {
    const page = ruleBody(ORCH, ".agx-settings-page:has(.agx-orch.agx-flow)");
    expect(page).toContain("height: 100%");
    // Under 1760px the band takes its own row and the page takes the rest.
    expect(ORCH).toMatch(/:has\(> \.agx-toc\) \{ grid-template-rows: auto minmax\(0, 1fr\); \}/);
    expect(ruleBody(ORCH, ".agx-settings-page:has(.agx-orch.agx-flow) > .agx-settings-content")).toContain("min-height: 0");
    expect(ORCH).toMatch(/\.agx-settings-col\[data-stable\] \{[^}]*flex: 1 1 0/);
  });

  test("the scope bar scrolls with the page and is not a second pinned row", () => {
    const bar = ruleBody(ORCH, ".agx-flow-pinned [data-scope-bar]");
    expect(bar).toContain("position: static");
    expect(bar).not.toContain("sticky");
    // The Save bar is the one sticky row left, inside the Safety card, and gives way in a very short window.
    expect(ORCH).toContain("@media (max-height: 440px) { .agx-flow-savebar[data-savebar] { position: static; } }");
  });

  test("the Polaris drawing is a view inside the scroller, not a second pinned stack", () => {
    const pinned = ruleBody(POLARIS, ".agx-pol-pinned");
    expect(pinned).not.toContain("position: sticky");
    expect(pinned).not.toMatch(/\btop:/);
    expect(pinned).not.toMatch(/\bz-index:/);
  });
});
