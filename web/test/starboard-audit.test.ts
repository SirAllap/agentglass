// What a pass over the compiled Starboard at 900/1280/1920/2560 found, asserted
// against source: there is no renderer here, and the measured side (the clipped
// frames) is in the change description.
import { test, expect, describe } from "bun:test";

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const view = await Bun.file(new URL("../src/components/StarboardView.tsx", import.meta.url)).text();
const feed = await Bun.file(new URL("../src/components/Feed.tsx", import.meta.url)).text();
const panels = await Bun.file(new URL("../src/components/StarboardPanels.tsx", import.meta.url)).text();

const container = (head: string) => {
  const i = css.indexOf(head);
  expect(i).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("\n}", i));
};

describe("the header at a laptop's width", () => {
  const md = container("@container sb (max-width: 1699px)");

  test("the controls take a line of their own instead of running under the clock", () => {
    expect(md).toContain("flex-wrap: wrap");
    expect(md).toContain(".sb-controls { order: 2; flex: 1 0 100%; }");
    expect(md).toContain("grid-template-rows: 66px 84px");
  });
});

describe("the live feed's own controls", () => {
  test("are explained by the house tip, never by the browser's own", () => {
    for (const tip of [
      'data-tip={follow ? "Following live — click to pause"',
      'data-tip="Type to filter events. Regex works, e.g. tool.*fail"',
      'data-tip="One column per session — parallel sessions get their own lane"',
      'data-tip="Fullscreen — expand the live feed (Esc closes)"',
    ]) expect(feed).toContain(tip);
    expect(feed).not.toMatch(/title=\{follow \?/);
    expect(feed).not.toMatch(/title="Type to filter events/);
    expect(feed).not.toMatch(/title="One column per session/);
    expect(feed).not.toMatch(/title="Fullscreen — expand/);
  });
});

describe("a reload the person can see", () => {
  test("the view says it is recalculating, not only dims", () => {
    expect(view).toContain('data-tip={refreshing ? "Recalculating…" : undefined}');
    expect(view).toMatch(/\{refreshing && <Spinner/);
    expect(view).toMatch(/data-on=\{refreshing \? "1" : undefined\}/);
    // The space is reserved: the selects must not jump while it comes and goes.
    expect(css).toMatch(/\.sb-recalc \{[^}]*min-width: [\d.]+em/);
    // A small spinner, never a pill: the pill read as the loudest thing in the header.
    expect(css).not.toMatch(/\.sb-recalc\[data-on\]/);
    expect(view).not.toContain('label="Recalculating…"');
  });
});

describe("the Orrery says what it left out", () => {
  test("a name that had no clean spot is counted in the panel's own line", () => {
    // `orreryPlan` counts them; the panel used to read every field of the plan
    // but this one, so a crowded panel hid names and said nothing.
    expect(panels).toContain("${plan.dropped ? ` · ${plan.dropped} ${plan.dropped === 1 ? \"name\" : \"names\"} on hover` : \"\"}");
  });
});
