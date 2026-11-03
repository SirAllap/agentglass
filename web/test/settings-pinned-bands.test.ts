/*
 * A pinned band is only a band while the window has room for it.
 *
 * The Settings frame keeps a fixed header and ONE scroll region. Everything
 * else that sticks — the index band, the Orchestration scope bar, the preview
 * beside a page's cards, the bulk bar on Git and pull requests — is a second
 * pinned row, and a pinned row taller than what is left of the region covers
 * the page instead of helping it: measured on Orchestration at 640x360, the
 * scope bar sat over the row under it and the section below was a 78px window
 * with its own 1691px scroller.
 *
 * So every rule in the frame's stylesheets that says `position: sticky` has to
 * answer a `@media (max-height: …)` (or width) with the same selector at
 * `position: static`. This reads the stylesheets, because the failure is a
 * media query nobody wrote, and no renderer here can be asked about one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

/** The stylesheets the Settings frame and its pages draw with. */
const SHEETS = [
  "index.css",
  "components/settingsSplit.css",
  "components/settingsGroupB.css",
  "components/cleanupSettings.css",
  "components/orchestration/orchestration.css",
];

type Rule = { sel: string; body: string; media: string[] };

/** Every style rule in a stylesheet, with the media conditions it sits under. */
function rules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const close = (at: number): number => {
    let depth = 0;
    for (let i = at; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return i;
    }
    return src.length;
  };
  const walk = (from: number, to: number, media: string[]) => {
    let start = from;
    for (let i = from; i < to; i++) {
      if (src[i] !== "{") continue;
      const head = src.slice(start, i).trim();
      const end = close(i);
      if (head.startsWith("@media")) walk(i + 1, end, [...media, head]);
      else if (!head.startsWith("@")) out.push({ sel: head, body: src.slice(i + 1, end), media });
      i = end;
      start = end + 1;
    }
  };
  walk(0, src.length, []);
  return out;
}

/** The selectors of a rule, split on the commas that separate top-level lists. */
const parts = (sel: string) => sel.split(",").map((s) => s.trim()).filter(Boolean);
const PINNED = /(?:^|[;{\s])position:\s*sticky/;
const STOPPED = /(?:^|[;{\s])position:\s*static/;
const SMALL = /max-(?:height|width):\s*\d+px/;
/* The frame's own rows. index.css also carries the workspace panes and the file
   viewer, which have their own scrollports and are not part of this sheet. */
const IN_FRAME = /^\.agx-(?:toc|settings|scard|ph|sn|sp|flow|cl|split)/;

const ALL = SHEETS.flatMap((f) => rules(read(f)).map((r) => ({ ...r, file: f })));
const inFrame = (r: Rule) => parts(r.sel).every((p) => IN_FRAME.test(p));
const pinned = ALL.filter((r) => PINNED.test(r.body) && inFrame(r));
const stops = ALL.filter((r) => STOPPED.test(r.body) && r.media.some((m) => SMALL.test(m)));

describe("every pinned band stops pinning in a small window", () => {
  test("the sheets declare the bands this test is about", () => {
    const sels = pinned.map((r) => r.sel).sort();
    expect(sels).toEqual([
      ".agx-cl-bulk",
      ".agx-cl-list",
      ".agx-flow .agx-rule-foot",
      ".agx-flow-savebar[data-savebar]",
      ".agx-split-side",
      ".agx-toc",
    ]);
  });

  test.each(pinned.map((r) => [r.file, r.sel] as const))("%s · %s has a small-window stop rule", (_file, sel) => {
    for (const own of parts(sel)) {
      const covered = stops.some((s) => parts(s.sel).some((p) => p === own || p.endsWith(own)));
      // Named in the failure so the next band is a two-line fix, not a search.
      expect({ band: own, stopped: covered }).toEqual({ band: own, stopped: true });
    }
  });

  test("the Orchestration page is the page scrolling at every height, never a second scrollbar", () => {
    const orch = read("components/orchestration/orchestration.css");
    expect(orch).toContain(".agx-settings-page:has(.agx-orch.agx-flow) { height: auto; }");
    expect(orch).toContain(".agx-orch.agx-flow { flex: none; height: auto; }");
    expect(orch).toContain(".agx-flow-pinned [data-scope-bar] { position: static; margin-bottom: 0; }");
    expect(ruleIn(orch, ".agx-flow-cfg")).toContain("flex: none");
    // The section's own scroller was the 78px window; the frame's region replaces it, above 960px as well as below.
    expect(ruleIn(orch, ".agx-flow-cfgscroll")).toContain("overflow: visible");
    expect(orch).not.toMatch(/\.agx-flow-cfgscroll \{[^}]*overflow-y: auto/);
  });

  test("the frame's index band and the page header give way at 300%", () => {
    const css = read("index.css");
    const at = css.indexOf("@media (max-height: 440px)");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("\n}\n", at) + 3);
    expect(block).toContain(".agx-settings-page > .agx-toc { position: static; }");
    expect(block).toContain(".agx-ph-sum { display: none; }");
    // Both offsets go with the band, or a scrolled-to card lands under air.
    expect(block).toContain("--agx-band: 0px");
    expect(block).toContain("--agx-pin-top: 0px");
  });
});

describe("a narrow window keeps its controls on the page", () => {
  const CSS = read("index.css");
  const rule = (sel: string) => {
    const at = CSS.indexOf(`${sel} {`);
    return at < 0 ? "" : CSS.slice(CSS.indexOf("{", at) + 1, CSS.indexOf("}", at));
  };

  test("a status that is a sentence wraps in the control column", () => {
    // Measured at 427x240 on Usage & budgets: the badge's right edge was 1002.
    const slot = rule(".agx-slot");
    expect(slot).toContain("min-width: 0");
    expect(slot).toContain("max-width: 100%");
    const badge = rule(".agx-slot > .agx-badge");
    expect(badge).toContain("white-space: normal");
    expect(badge).toContain("flex: 0 1 auto");
  });

  test("the tabs row has no note, and the section tabs wrap", () => {
    const orch = read("components/orchestration/orchestration.css");
    // The hint strip and the tabs row's note are gone: the cards say what the note did.
    expect(orch).not.toContain(".agx-flow-said {");
    expect(orch).not.toContain(".agx-flow-cfgnote");
    expect(ruleIn(orch, ".agx-flow-tabs")).toContain("flex-wrap: wrap");
    // The Flow/Polaris switch is gone; Polaris has its own page.
    expect(orch).not.toContain(".agx-flow-bar > .agx-seg");
  });
});

/** A rule's body, searched in the given stylesheet. */
function ruleIn(css: string, sel: string): string {
  const at = css.indexOf(`${sel} {`);
  return at < 0 ? "" : css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
}
