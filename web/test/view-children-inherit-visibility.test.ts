import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/?\*|\/\/)/.test(l)).join("\n");

// A view that is not on screen is hidden with `visibility: hidden` on its root. A child that says `visibility: visible`
// for itself comes back out of that: the Starboard's Clear button floated over the Diff and Docker views.
describe("a control inside a view never forces itself visible", () => {
  for (const f of ["../src/components/StarboardView.tsx", "../src/components/projects/Rows.tsx"]) {
    test(`${f.split("/").pop()} shows by inheriting, not by saying visible`, async () => {
      const src = code(await read(f));
      expect(src).not.toMatch(/visibility:[^\n]*\? "visible"/);
      expect(src).toMatch(/\? "inherit" : "hidden"/);
    });
  }
});
