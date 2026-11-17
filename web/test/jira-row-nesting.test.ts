/*
 * Source rules for a sub-task row: nothing may sit on top of the title, the checkbox and the chevron each keep their own
 * fixed slot, and a child reads as notably indented under its parent. No renderer here, so these are read straight from the
 * component and the stylesheet.
 */
import { describe, expect, test } from "bun:test";

const dir = import.meta.dir + "/../src/components/jira/list/";
const read = (f: string) => Bun.file(dir + f).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const css = () => Bun.file(import.meta.dir + "/../src/index.css").text();

describe("a sub-task's elbow glyph never overlaps the title", () => {
  test("the elbow is a normal flex item, not pinned over the text with position: absolute", async () => {
    const sheet = await css();
    const rule = sheet.match(/\.agx-jl-elbow\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).not.toContain("position: absolute");
    expect(rule).not.toContain("left:");
    expect(rule).not.toContain("top:");
  });
  test("it is still the first thing in the title, so it reads before the text", async () => {
    const row = code(await read("JiraRow.tsx"));
    expect(row).toContain('<div className="agx-jl-title">\n          {nested && <span className="agx-jl-elbow" aria-hidden><SubIcon /></span>}');
  });
});

describe("the checkbox and the chevron each keep their own slot", () => {
  test("both live as ordinary flex items of one gutter, not an overlay pinned on top of the row", async () => {
    const row = code(await read("JiraRow.tsx"));
    expect(row).toContain('<div className="agx-jl-gutter">');
    const gutter = row.match(/<div className="agx-jl-gutter">[\s\S]*?\n      <\/div>/)?.[0] ?? "";
    expect(gutter).toContain('className="agx-jl-cb"');
    expect(gutter).toContain('className="agx-jl-twist"');
  });
  test("the checkbox is a fixed 20px flex item, no longer an absolute overlay on the chevron's track", async () => {
    const sheet = await css();
    const rule = sheet.match(/\.agx-jl-cb\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).not.toContain("position: absolute");
    expect(rule).toContain("flex: none");
    expect(rule).toContain("width: 20px");
  });
  test("the gutter track widened to fit both 20px slots side by side", async () => {
    const model = await Bun.file(import.meta.dir + "/../src/components/jira/list/laneModel.ts").text();
    expect(model).toMatch(/twist:\s*42/);
  });
});

describe("a sub-task reads as notably indented under its parent", () => {
  test("one level steps the row in 28px", async () => {
    const sheet = await css();
    expect(sheet).toMatch(/\.agx-jl-row\.is-sub\s*\{\s*margin-left:\s*28px/);
  });
  /* The Jira skin is the one the app draws, and its `.agx-jmock .agx-jl-row { margin: 0 }` has the same specificity
     as the step and lands later in the bundle, so it wins: the skin's own sub-task rule has to carry the step again.
     Measured in the installed app: without it every child started at the parent's x. A 0px gutter track for a child
     once also let the checkbox spill out of a column that was not there. */
  test("the Jira skin keeps the step and the child keeps its gutter track", async () => {
    const skin = await Bun.file(import.meta.dir + "/../src/jiraMock.css").text();
    expect(skin).toMatch(/\.agx-jmock \.agx-jl-row\s*\{[^}]*margin:\s*0/);
    expect(skin).toMatch(/\.agx-jmock \.agx-jl-row\.is-sub\s*\{[^}]*margin-left:\s*28px/);
    expect(code(await read("JiraLanes.tsx"))).not.toContain("0px");
  });
  test("a thin guide line runs from the row above down into each child", async () => {
    const sheet = await css();
    const rule = sheet.match(/\.agx-jl-row\.is-sub::before\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("width: 1px");
  });
});

describe("the elbow stays inline with the first line of a wrapped title", () => {
  test("a sub-task's title aligns its items to the top, and the elbow is one text line tall", async () => {
    const sheet = await css();
    expect(sheet).toMatch(/\.agx-jl-row\.is-sub \.agx-jl-title\s*\{\s*align-items:\s*flex-start/);
    expect(sheet.match(/\.agx-jl-elbow\s*\{[^}]*\}/)?.[0] ?? "").toContain("height: 1.35em");
  });
  /* Measured: the skin's `.agx-jl-title` is `flex-wrap: wrap`, so a long title (flex-basis = its one-line width) wrapped to its own flex line
     and the elbow stood alone above it. The title text has to be capped under the line's width so it shares the elbow's line. */
  test("the skin caps a sub-task's title text under the line width so a wrapping title stays on the elbow's line", async () => {
    const skin = await Bun.file(import.meta.dir + "/../src/jiraMock.css").text();
    expect(skin).toMatch(/\.agx-jmock \.agx-jl-title\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(skin).toMatch(/\.agx-jmock \.agx-jl-row\.is-sub \.agx-jl-title \.agx-jl-trunc\s*\{[^}]*max-width:\s*calc\(100%\s*-\s*\d+px\)/);
  });
});
