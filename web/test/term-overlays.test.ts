/*
 * Find and the pluck palette must leave the tab strip's More and gear reachable.
 */
import { describe, expect, test } from "bun:test";

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
/** Source without its comment lines, so a word in a comment cannot satisfy a rule about code. */
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
const panel = await read("../src/components/TerminalPanel.tsx");

/** The text of the <div> that opens at `from`, up to its own closing tag. */
function divAt(s: string, from: number): string {
  let depth = 0;
  for (const m of s.slice(from).matchAll(/<div\b|<\/div>/g)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return s.slice(from, from + m.index! + m[0].length);
  }
  return "";
}

describe("overlays on the terminal", () => {
  test("find and the pluck palette sit inside the pane area, under the tab strip", () => {
    const c = code(panel);
    const ref = c.indexOf("ref={wrapRef}");
    expect(ref).not.toBe(-1);
    const area = divAt(c, c.lastIndexOf("<div", ref));
    expect(area).toContain("<PluckPalette");
    expect(area).toContain("<FindBar sess");
  });

  test("and nowhere else", () => {
    const c = code(panel);
    expect(c.split("<FindBar sess").length).toBe(2);
    expect(c.split("<PluckPalette").length).toBe(2);
  });
});
