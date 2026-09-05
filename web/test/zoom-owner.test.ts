/*
 * Who answers a zoom gesture.
 *
 * Written after two fixes that did not work, and the reason both failed is the thing
 * this file exists to encode: the application's own zoom is bound at the WINDOW, in
 * the CAPTURE phase, so it runs before any listener a component attaches to its own
 * node. With the image viewer open, one Ctrl+wheel therefore zoomed the interface AND
 * the picture — two handlers, both ours, neither able to preventDefault its way past
 * the other.
 */
import { describe, expect, it } from "bun:test";
import { claimZoom, zoomOwner, zoomTaken } from "../src/lib/zoomOwner.ts";

describe("zoomOwner", () => {
  it("is nobody's until something asks", () => {
    expect(zoomTaken()).toBe(false);
    expect(zoomOwner()).toBeNull();
  });

  it("hands it over, and gives it back", () => {
    const release = claimZoom("image-viewer");
    expect(zoomTaken()).toBe(true);
    expect(zoomOwner()).toBe("image-viewer");
    release();
    expect(zoomTaken()).toBe(false);
  });

  // A release from something that no longer holds it must not take the zoom away from
  // whoever does — an unmount arriving late is exactly that.
  it("a stale release cannot take it from the current owner", () => {
    const staleRelease = claimZoom("first");
    claimZoom("second");
    staleRelease();
    expect(zoomOwner()).toBe("second");
    expect(zoomTaken()).toBe(true);
  });

  it("and releasing twice is harmless", () => {
    const release = claimZoom("once");
    release();
    release();
    expect(zoomTaken()).toBe(false);
  });
});
