/*
 * An unsplit window's one pane is answered from the window's book, not asked again every tick.
 */
import { describe, expect, test } from "bun:test";
import { bookPanes } from "../src/lib/paneWorktree.ts";

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
/** Source without its comment lines, so a word in a comment cannot satisfy a rule about code. */
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
const panel = await read("../src/components/TerminalPanel.tsx");

describe("pane memory", () => {
  const panes = [
    { pane: "%0", active: true, dirs: ["/orbit"], agent: "a" },
    { pane: "%1", active: false, dirs: ["/other"], agent: "" },
  ];

  test("an unsplit window finds its pane under the empty id", () => {
    expect(bookPanes(panes).get("")?.dirs).toEqual(["/orbit"]);
  });

  test("ids still answer for their own pane", () => {
    expect(bookPanes(panes).get("%1")?.dirs).toEqual(["/other"]);
  });

  test("no active pane, no empty-id entry", () => {
    expect(bookPanes([{ pane: "%1", active: false }]).has("")).toBe(false);
  });

  test("a window switch empties the book before the first read of the new window", () => {
    const c = code(panel);
    const effect = c.slice(c.indexOf("const fill = () =>") - 200, c.indexOf("fillRef.current = fill;"));
    expect(effect).toContain("paneBook.current = new Map();");
    expect(effect.indexOf("paneBook.current = new Map();")).toBeLessThan(effect.indexOf("const fill = () =>"));
  });
});
