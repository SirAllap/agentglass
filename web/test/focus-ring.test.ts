import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * Where the keyboard focus ring is allowed to land.
 *
 * The ring carries `!important`, because the app clears outlines everywhere and
 * a keyboard user was otherwise left with no signal at all. That `!important`
 * also beat the `outline-none` on the panels that take `tabindex="-1"` — ten of
 * them, focusable by script so they can receive j/k, never reachable by Tab.
 * The result was a 2px accent rectangle drawn around a whole view, clipped on
 * two sides by the `overflow-hidden` parents it sat flush inside, which reads
 * as a broken border rather than as focus.
 *
 * Asserted on the stylesheet because the rule is the whole fix; the behaviour
 * it produces was checked against a real build, where the panel goes from a
 * visible accent outline to a transparent one and the button keeps its ring.
 */
const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

describe("the focus ring", () => {
  it("skips elements that exist only to be focused by script", () => {
    const rule = css.match(/^:focus-visible[^{]*\{/m)?.[0] ?? "";
    expect(rule).toContain(':not([tabindex="-1"])');
  });

  it("still overrides the utility classes that cleared the outline", () => {
    // Without !important there is no ring anywhere, which is the bug this rule
    // was added for in the first place.
    const block = css.match(/^:focus-visible[^{]*\{[^}]*\}/m)?.[0] ?? "";
    expect(block).toMatch(/outline:[^;]*!important/);
    expect(block).toContain("var(--primary)");
  });
});
