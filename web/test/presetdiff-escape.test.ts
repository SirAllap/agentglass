// The commit-diff modal ignored Escape; only its X closed it. And a first
// version closed the session modal under it and any open menu in it as well:
// a window listener cannot stop other window listeners.
import { expect, it } from "bun:test";

const head = async () => {
  const src = await Bun.file(new URL("../src/components/diff/PresetDiff.tsx", import.meta.url)).text();
  return src.slice(src.indexOf("export function PresetDiff("), src.indexOf("return (\n    <Portal"));
};

it("PresetDiff listens for Escape while open", async () => {
  const h = await head();
  expect(h).toContain('e.key !== "Escape"');
  expect(h).toContain("onClose()");
});

it("it claims Escape in the capture phase, so the layers beneath never hear it", async () => {
  const h = await head();
  expect(h).toContain("document.addEventListener(\"keydown\", k, true)");
  expect(h).toContain("e.stopPropagation()");
});

it("it yields to a menu that is open inside it", async () => {
  expect(await head()).toContain("[role=menu],[role=listbox],[data-menu-layer]");
});
