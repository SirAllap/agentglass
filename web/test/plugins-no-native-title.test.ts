// The plugin views explain their controls with the house tooltip
// (`data-tip`, drawn by TipHost), never the browser's own `title`. A native
// title is a different box on every platform and opens on top of ours.
//
// Only HTML elements are checked: `title` on a component is that component's
// own prop (a column's heading, a dialog's heading). An <iframe> keeps its
// title, because that is the frame's accessible name.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "../src/components");
const views = readdirSync(join(src, "plugins")).filter((f) => f.endsWith(".tsx")).map((f) => `plugins/${f}`);

/** Every `title=` written on a lowercase (HTML) tag, as "file:line <tag>". */
function nativeTitles(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<=\s)title=/g)) {
    const before = text.slice(0, m.index);
    const tags = [...before.matchAll(/<([A-Za-z][\w.]*)/g)];
    const tag = tags.at(-1)?.[1] ?? "";
    if (/^[a-z]/.test(tag) && tag !== "iframe") out.push(`${file}:${before.split("\n").length} <${tag}>`);
  }
  return out;
}

describe("no native title in the plugin views", () => {
  test("the checker sees a title on an element and not on a component", () => {
    expect(nativeTitles("x", `<button\n  title="Go">`)).toEqual(["x:2 <button>"]);
    expect(nativeTitles("x", `<Column title="Go" />`)).toEqual([]);
    expect(nativeTitles("x", `<iframe title="Page" />`)).toEqual([]);
  });
  for (const f of views) {
    test(`${f} uses data-tip`, () => {
      expect(nativeTitles(f, readFileSync(join(src, f), "utf8"))).toEqual([]);
    });
  }
});
