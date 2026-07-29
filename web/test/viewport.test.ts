// Which device gets the phone application.
//
// Worth pinning precisely, because both mistakes are bad in a way the user
// cannot work around: a laptop that gets the phone UI has lost the terminal and
// the git panel, and a phone that gets the cockpit has a terminal it cannot
// type into. The saved override is the escape hatch from either.
import { describe, expect, test, beforeEach } from "bun:test";
import { wantsPhoneLayout, phoneLayoutNow, readOverride, LAYOUT_KEY } from "../src/lib/viewport.ts";

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

  test("a page served off-box gets the phone application whatever it measures", () => {
    // Chrome's "Desktop site" on a phone: 980px and a fine pointer reported by
    // a device that is neither. This is the report that put the cockpit on a
    // Pixel, and it must not be able to any more.
    expect(wantsPhoneLayout(980, false, null, true)).toBe(true);
    expect(wantsPhoneLayout(1440, false, null, true)).toBe(true);
    // Beats the saved override too: the phone is the one browser that could set
    // that for itself, so it cannot be the way back into the cockpit.
    expect(wantsPhoneLayout(1440, false, "desktop", true)).toBe(true);
  });

  test("local pages are unaffected by the remote rule", () => {
    expect(wantsPhoneLayout(1440, false, null, false)).toBe(false);
    expect(wantsPhoneLayout(390, true, null, false)).toBe(true);
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

describe("the published demo", () => {
  // The demo is on GitHub Pages with nothing behind it, and every rule above
  // is about capability: a phone gets its own application because it cannot
  // drive a terminal. The demo has no terminal, no git, no docker and no
  // server, so the only question left is what a stranger following the link
  // should be shown — and that is the cockpit, which is the part that is hard
  // to describe in words. The companion is already covered on the landing page
  // and in the README, with real screenshots.

  test("shows a phone the cockpit, which is what they came for", () => {
    expect(wantsPhoneLayout(390, true, null, false, true)).toBe(false);
    expect(wantsPhoneLayout(360, true, null, false, true)).toBe(false);
    // And the same viewport off the demo still gets the companion.
    expect(wantsPhoneLayout(390, true, null, false, false)).toBe(true);
  });

  test("changes nothing on a desk", () => {
    expect(wantsPhoneLayout(1440, false, null, false, true)).toBe(false);
    expect(wantsPhoneLayout(1440, false, null, false, false)).toBe(false);
  });

  test("still yields to somebody who asked for the companion by hand", () => {
    // Nothing in the UI writes this, so it is the one way left to look at the
    // companion demo on purpose. Losing that would make it unreachable.
    expect(wantsPhoneLayout(390, true, "mobile", false, true)).toBe(true);
    expect(wantsPhoneLayout(1440, false, "mobile", false, true)).toBe(true);
  });

  test("never lets the demo flag reach a device that came over the network", () => {
    // Belt and braces: the demo is never served with the remote marker, but
    // if the two ever met, the marker is a safety rule and must still win.
    expect(wantsPhoneLayout(1440, false, null, true, true)).toBe(true);
  });
});

describe("phoneLayoutNow, which is the part main.tsx actually calls", () => {
  // The rule above was covered and the wiring to it was not, which is how the
  // demo flag came to be dropped here — a mutation deleting it from this call
  // changed nothing that anything checked.
  const withWindow = (width: number, fn: () => void) => {
    const g = globalThis as Record<string, unknown>;
    const had = "window" in g;
    const prev = g.window;
    g.window = { innerWidth: width, matchMedia: () => ({ matches: true }) };
    try { fn(); } finally { if (had) g.window = prev; else delete g.window; }
  };

  test("hands the demo flag to the rule", () => {
    withWindow(390, () => {
      expect(phoneLayoutNow(true)).toBe(false);   // demo: the cockpit
      expect(phoneLayoutNow(false)).toBe(true);   // a real install: the companion
    });
  });

  test("answers false where there is no browser at all", () => {
    // Imported before React mounts, and on any server-side or test runtime
    // `window` is simply absent — a bare read would be a ReferenceError that
    // takes the whole app down at import time.
    expect(phoneLayoutNow(true)).toBe(false);
    expect(phoneLayoutNow(false)).toBe(false);
  });
});
