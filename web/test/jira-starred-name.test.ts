/*
 * A starred view in the Jira sidebar keeps its name once it is selected. The name and the view's JQL share one slot and
 * swap on hover; the swap also ran on focus and on aria-selected, so a clicked view lost its name, and a Jira filter
 * with no JQL read yet showed only its star and count. The rule is CSS, so it is asserted against the stylesheet.
 */
import { describe, expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.trim()).filter((r) => r.includes(".agx-jsb-name"));

describe("starred view row name", () => {
  test("no rule hides the name on a selected or focused row", () => {
    const hiding = rules.filter((r) => /display:\s*none/.test(r));
    expect(hiding.length).toBeGreaterThan(0);
    for (const r of hiding) {
      const sel = r.slice(0, r.indexOf("{"));
      expect(sel).not.toContain("aria-selected");
      expect(sel).not.toContain(":focus");
    }
  });
  test("the name only gives way when there is JQL to show instead", () => {
    for (const r of rules.filter((x) => /display:\s*none/.test(x))) expect(r.slice(0, r.indexOf("{"))).toContain(":has(.agx-jsb-jql)");
  });
});
