// The pull-request board explains its controls with the house tooltip (`data-tip`,
// drawn by TipHost), never the browser's own `title`. A native title is a
// different box on every platform and opens on top of ours.
//
// Only HTML elements are checked: `title` on a component is that component's
// own prop (a dialog's heading, a row square's label). An <iframe> keeps its
// title, because that is the frame's accessible name.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "../src/components");
const views = ["PrPanel.tsx", "TriageBoard.tsx"];

/** Every `title=` written on a lowercase (HTML) tag, as "file:line <tag>". */
function nativeTitles(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<=\s)title=/g)) {
    const before = text.slice(0, m.index);
    const tags = [...before.matchAll(/(?<![\w$])<([A-Za-z][\w.]*)/g)];
    const tag = tags.at(-1)?.[1] ?? "";
    if (/^[a-z]/.test(tag) && tag !== "iframe") out.push(`${file}:${before.split("\n").length} <${tag}>`);
  }
  return out;
}

describe("no native title on the pull-request board", () => {
  test("the checker sees a title on an element and not on a component", () => {
    expect(nativeTitles("x", `<span\n  title="Go">`)).toEqual(["x:2 <span>"]);
    expect(nativeTitles("x", `<RowSquare title="Go" />`)).toEqual([]);
    // A type argument is not a tag: Promise<void> before a component's title.
    expect(nativeTitles("x", `<Refresh onClick={() => new Promise<void>((r) => r())}\n  title="Go" />`)).toEqual([]);
  });
  for (const f of views) {
    test(`${f} uses data-tip`, () => {
      expect(nativeTitles(f, readFileSync(join(src, f), "utf8"))).toEqual([]);
    });
  }
});
