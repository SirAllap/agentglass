// Which device gets the phone application.
//
// Worth pinning precisely, because both mistakes are bad in a way the user
// cannot work around: a laptop that gets the phone UI has lost the terminal and
// the git panel, and a phone that gets the cockpit has a terminal it cannot
// type into. The saved override is the escape hatch from either.
import { describe, expect, test, beforeEach } from "bun:test";
import { wantsPhoneLayout, readOverride, LAYOUT_KEY } from "../src/lib/viewport.ts";

describe("wantsPhoneLayout", () => {
  test("narrow viewports get the phone application", () => {
    expect(wantsPhoneLayout(390, true)).toBe(true); // iPhone portrait
    expect(wantsPhoneLayout(412, true)).toBe(true); // Pixel portrait
    expect(wantsPhoneLayout(767, false)).toBe(true);
  });

  test("a desk gets the cockpit", () => {
    expect(wantsPhoneLayout(1440, false)).toBe(false);
    expect(wantsPhoneLayout(1024, false)).toBe(false);
    expect(wantsPhoneLayout(768, false)).toBe(false);
  });

  test("a touch device up to 900px is a phone in landscape", () => {
    // 844px wide with a coarse pointer is an iPhone on its side, not a laptop.
    expect(wantsPhoneLayout(844, true)).toBe(true);
    expect(wantsPhoneLayout(900, true)).toBe(true);
    // A tablet has the room for the real thing.
    expect(wantsPhoneLayout(1024, true)).toBe(false);
  });

  test("a narrow window on a desktop is still a desktop above the breakpoint", () => {
    // Mouse, half-width window: the cockpit reflows, and widening it must not
    // require a reload to get back.
    expect(wantsPhoneLayout(820, false)).toBe(false);
  });

  test("an explicit choice wins over any measurement", () => {
    expect(wantsPhoneLayout(1920, false, "mobile")).toBe(true);
    expect(wantsPhoneLayout(360, true, "desktop")).toBe(false);
  });
});

describe("readOverride", () => {
  const store = new Map<string, string>();
  const fake = { getItem: (k: string) => store.get(k) ?? null };

  beforeEach(() => store.clear());

  test("null when nothing is saved", () => {
    expect(readOverride(fake)).toBe(null);
  });

  test("reads the two valid values and ignores anything else", () => {
    store.set(LAYOUT_KEY, "mobile");
    expect(readOverride(fake)).toBe("mobile");
    store.set(LAYOUT_KEY, "desktop");
    expect(readOverride(fake)).toBe("desktop");
    store.set(LAYOUT_KEY, "tablet-please");
    expect(readOverride(fake)).toBe(null);
  });

  test("survives storage that throws (private mode, blocked cookies)", () => {
    expect(readOverride({ getItem: () => { throw new Error("denied"); } })).toBe(null);
    expect(readOverride(null)).toBe(null);
  });
});
