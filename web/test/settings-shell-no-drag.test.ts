/*
 * Settings covers the TopBar, whose strip is a window-drag region.
 *
 * Electron builds the drag region from rectangles and ignores z-index, so the
 * top ~44px of a full-screen layer over it swallowed clicks: a button there
 * answered only where the TopBar had a no-drag control underneath. The shell
 * opts out the same way every layer over the TopBar does (see dragRegion.ts).
 */
import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();

test("the Settings shell is no-drag", () => {
  const at = src.indexOf('className="agx-settings-shell');
  expect(at).toBeGreaterThan(0);
  const tag = src.slice(at, src.indexOf(">", src.indexOf("style={{", at)) + 1);
  expect(tag).toContain("...NO_DRAG");
});
