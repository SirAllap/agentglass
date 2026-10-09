import { test, expect } from "bun:test";
import { followBox } from "../src/lib/paletteModel.ts";
import { readPath } from "../src/lib/finderQuery.ts";

const HOME = "/home/ada";

/* A file clicked in a terminal opened the finder with the box saying only its
 * folder, while the path bar and the centre header named the file. */
test("a file is written out in full, and the list still reads its folder", () => {
  const m = followBox("/home/ada/notes/pr-1042-replies.md", false, HOME);
  expect(m.text).toBe("~/notes/pr-1042-replies.md");
  expect(m.dirText).toBe("~/notes/");
  const list = readPath(m.dirText, HOME, HOME)!;
  expect(list).toEqual({ dir: "/home/ada/notes", tail: "", atFolder: true });
});

test("a folder ends in a slash", () => {
  expect(followBox("/home/ada/notes/orbit", true, HOME).text).toBe("~/notes/orbit/");
  expect(followBox("/home/ada/notes/orbit/", true, HOME).text).toBe("~/notes/orbit/");
  expect(followBox("/home/ada/notes/orbit", true, HOME).dirText).toBe("~/notes/");
});

test("outside home and at the root", () => {
  expect(followBox("/srv/app/x.md", false, HOME)).toEqual({ text: "/srv/app/x.md", dirText: "/srv/app/" });
  expect(followBox("/x.md", false, HOME)).toEqual({ text: "/x.md", dirText: "/" });
});

test("typing a file path selects that file: the tail is the filter", () => {
  expect(readPath("~/notes/a.md", HOME, HOME)).toEqual({ dir: "/home/ada/notes", tail: "a.md", atFolder: false });
});

const src = await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text();
test("the palette mirrors the selection and clears the mirror when the box is edited", () => {
  expect(src).toContain("followBox(selAbs");
  expect(src).toMatch(/onChange=\{\(e\) => \{ setBoxMirror\(null\);/);
  expect(src).toContain("readPath(readQ,");
});
