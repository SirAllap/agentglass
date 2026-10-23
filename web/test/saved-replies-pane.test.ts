/*
 * A saved reply is what somebody wrote to post under their own name — the
 * same shape as a pull request body or a comment. docs/design-system.md's
 * "Prose font for what a person wrote, mono for the machine" says that text
 * reads in --font-prose, not the app's default monospace stack. There is no
 * renderer for this pane's async list (it fetches on mount), so the rule is
 * asserted against the source, the way other panes without a renderer are.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/SavedRepliesPane.tsx", import.meta.url), "utf8");

describe("a saved reply's own words", () => {
  test("the list preview reads in the prose face, not the mono default", () => {
    const preview = src.slice(src.indexOf("The text itself is what a person wrote"), src.indexOf("})),", src.indexOf("The text itself is what a person wrote")));
    expect(preview).toContain("var(--font-prose)");
  });

  test("the box you type it into reads in the prose face too", () => {
    const box = src.slice(src.indexOf("<textarea id=\"saved-reply-text\""), src.indexOf("</Field>", src.indexOf("<textarea id=\"saved-reply-text\"")));
    expect(box).toContain("var(--font-prose)");
    expect(box).not.toContain("var(--diff-font");
  });
});
