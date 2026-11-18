import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
const rule = (sel: string) => {
  const i = css.indexOf(`${sel} {`);
  expect(i).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("}", i));
};

describe("Jira tile step button keeps its label", () => {
  test("the primary button never shrinks below its label", () => {
    const r = rule(".agx-jt-act");
    expect(r).toContain("flex: 0 0 auto");
    expect(r).toContain("min-width: max-content");
  });
  test("the label is never hidden or ellipsised", () => {
    expect(rule(".agx-jt-lbl")).not.toContain("ellipsis");
    expect(css).not.toMatch(/\.agx-jt-lbl \{ display: none/);
  });
  test("the action row wraps instead of squeezing", () => {
    expect(rule(".agx-jt-acts")).toContain("flex-wrap: wrap");
  });
  test("NOW line: the bar gives way before the word, button keeps its label", () => {
    expect(rule(".agx-jt-now .ring")).toMatch(/flex: 0 100 36px/);
    expect(css).toMatch(/\.agx-jt-now \.w \{ flex: 1 1 auto/);
    expect(css).toMatch(/\.agx-jt-now button \{[^}]*min-width: max-content/);
  });
});
