/*
 * The preview divider follows the pointer from where it is. A panel that has not
 * been dragged fills the strip and is wider than the default, so a drag that
 * started from the default width moved the divider 395 px on its first 2 px.
 */
import { describe, expect, test } from "bun:test";
import { dragPreviewWidth, previewWidth } from "../src/lib/finderColumns.ts";

const machine = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();

describe("dragPreviewWidth", () => {
  test("two pixels of drag move the panel two pixels from where it is", () => {
    expect(dragPreviewWidth(1400, 523, 900, 898)).toBe(525);
    expect(dragPreviewWidth(1400, 523, 900, 902)).toBe(521);
  });
  test("no movement is no change, the clamps still hold", () => {
    expect(dragPreviewWidth(1400, 523, 900, 900)).toBe(523);
    expect(dragPreviewWidth(1400, 523, 900, 0)).toBe(previewWidth(1400, 5000));
    expect(dragPreviewWidth(1400, 523, 900, 1400)).toBe(240);
  });
});

describe("the grip", () => {
  test("starts from the measured width, not from the computed default", () => {
    const grip = machine.slice(machine.indexOf('aria-label="Resize the preview"'), machine.indexOf("onKeyDown", machine.indexOf('aria-label="Resize the preview"')));
    expect(grip).toContain("getBoundingClientRect().width");
    expect(grip).toContain("dragPreviewWidth(");
  });
});
