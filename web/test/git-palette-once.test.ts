// One Ctrl+K inside Git opened the Git palette AND the app palette beneath it.
import { expect, it } from "bun:test";

it("the Git panel's Ctrl+K stops at the panel", async () => {
  const src = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
  const i = src.indexOf("setPaletteOpen(true);\n      return;");
  expect(i).toBeGreaterThan(0);
  expect(src.slice(i - 400, i)).toContain("e.stopPropagation()");
});

it("an empty query lists each object once, not once per action", async () => {
  const { paletteEntries, onePerObject } = await import("../src/lib/gitActions.ts");
  const rows = ["a", "b", "c"].map((name) => ({ kind: "branch" as const, name }));
  const all = paletteEntries(rows);
  const once = onePerObject(all);
  expect(all.length).toBeGreaterThan(3);
  expect(once.map((e) => e.name)).toEqual(["a", "b", "c"]);
});
