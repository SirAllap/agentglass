/*
 * The finder as a workspace, asserted at the seams that fixed each thing.
 *
 * There is no renderer in this project, so what the screen must keep doing is
 * pinned in the source that does it — and every assertion here was watched go
 * red against the old behaviour: a search result that opened a bench tab, a
 * glob sent to a server that matches names, a closed finder that forgot where
 * it was.
 */
import { describe, expect, test } from "bun:test";

const palette = await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text();
const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const bodyOf = (src: string, head: string): string => {
  const at = src.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`no closing brace for ${head}`);
};

describe("opening a file no longer leaves the finder", () => {
  const open = code(bodyOf(palette, "const openRow = useCallback("));
  test("openRow never hands a file to the bench or the viewer itself", () => {
    expect(open).not.toContain("onOpenFile(");
    expect(open).not.toContain("onBench(");
    expect(open).toContain("focusViewer()");
  });
  test("the bench is one function, reached by ⌘⏎ and by the button", () => {
    const bench = code(bodyOf(palette, "const benchRow = useCallback("));
    expect(bench).toContain("onBench(");
    expect(bench).toContain("onClose()");
    expect(open).toContain("benchRow(row)");
    expect(code(palette)).toContain("onBench={() => benchRow(selRow)}");
  });
  test("App puts a bench request on the bench, and nothing in the finder raises the old document viewer", () => {
    expect(code(app)).toContain("onBench={(o) => {");
    expect(code(app)).toContain("showFile(o.root, o.path");
    expect(code(palette)).not.toContain("setPeek");
  });
});

describe("a glob is a filter, not a search", () => {
  test("no server search runs for one, on either tab that has a folder", () => {
    const c = code(palette);
    expect(c).toContain("q.trim().length > 0 && !globAsked");
    expect(c).toContain('q.trim().length >= 2 && !globAsked');
  });
  test("a pattern keeps what it matches instead of scoring it as a fuzzy name", () => {
    expect(code(palette)).toContain("hasGlob(needle) && tab !== \"contents\"");
    expect(code(palette)).toContain("matchGlob(needle, r.rel)");
  });
});

describe("the chips", () => {
  test("are counted before they are applied, and a chip that is not in the list filters nothing", () => {
    const c = code(palette);
    expect(c).toContain("extChips(matched.filter");
    expect(c).toContain("exts.filter((e) => chips.some((c) => c.ext === e))");
  });
});

describe("reopening puts it back", () => {
  test("the state is read once at mount and written on every change and on close", () => {
    const c = code(palette);
    expect(c).toContain("restore(readSnap())");
    expect(c).toContain("writeSnap(snap.current)");
    expect(c).toContain("if (!open && saveTimer.current)");
    expect(c).toContain("pendingSel");
  });
  test("a checkout loading in the background does not reset the Machine tab's selection", () => {
    expect(code(palette)).toContain('[tab, q, tab === "machine" ? place : root, browsePath]');
  });
  test("a closed finder holds no file", () => {
    expect(code(palette)).toContain("if (!open || !selRow || !selAbs) return null;");
  });
});
