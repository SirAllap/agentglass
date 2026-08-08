/*
 * The shape of the navigation, and the one number it turns on.
 *
 * Two things are checked here that a screenshot cannot: that every screen this
 * app has is still reachable, and that no label goes into the bar without
 * somebody measuring it. Both are regressions that are invisible until they are
 * shipped — a route nobody links to looks fine on every screen it is not on,
 * and a label that overflows only does so on somebody else's text-size setting.
 *
 * What this file does NOT check is what the bar looks like. That was verified
 * on the emulator, in both modes and at 130%, and an assertion about a number
 * is not evidence about a screen.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BAR, OFF_BAR, PUSHED, type TabRoute } from "../src/nav/bar.ts";

/**
 * How wide each word is, in dp, at the bar's 10px in the weight it is drawn.
 *
 * Measured, not estimated, and the method is worth writing down because the
 * next person to add a destination has to repeat it:
 *
 *   adb pull /system/fonts/Roboto-Regular.ttf     (Android 16, API 36 image)
 *   serve it, and lay the word out in Chrome at `font-weight: 500` against a
 *   @font-face declaring `font-weight: 100 900` — Roboto ships as a variable
 *   font and Medium is an instance of it, so a static-metrics reading is
 *   Regular's and comes out ~1.3% narrow.
 *
 * The cross-check: "Terminal" reads 39.30 here and 38.78 at Regular, and 39.3
 * is the number the old seven-tab layout was arguing with. That layout's claim
 * was right.
 */
const DP_AT_10PX: Record<string, number> = {
  Home: 26.84,
  Chats: 25.95,
  Terminal: 39.30,
  Review: 31.88,
  Repos: 28.09,
};

/** The narrowest phone worth designing for, and the emulator this was looked
 *  at on. */
const PHONES = [360, 411.4];
/** BottomTabItem puts 5 points of padding either side of its content — the
 *  number is in expo-router's own copy of it,
 *  build/react-navigation/bottom-tabs/views/BottomTabItem.js. */
const ITEM_PADDING = 10;

const slot = (screenDp: number, items: number): number => screenDp / items - ITEM_PADDING;

describe("the bar", () => {
  test("five destinations, and the star is the middle one", () => {
    // Centred is a property of an odd count, not of an index: four items with
    // the star third is not centred, it is off to the right.
    expect(BAR.length).toBe(5);
    expect(BAR.length % 2).toBe(1);
    const star = BAR.findIndex((d) => d.star);
    expect(star).toBe((BAR.length - 1) / 2);
    expect(BAR[star]?.route).toBe("terminal");
    expect(BAR.filter((d) => d.star)).toHaveLength(1);
  });

  test("the star carries no label and everything else does", () => {
    for (const dest of BAR) {
      if (dest.star) expect(dest.label, `${dest.route} is the star`).toBeUndefined();
      else expect(dest.label, `${dest.route} has no label`).toBeTruthy();
    }
  });

  test("every word in it has been measured", () => {
    // The lock. A destination whose label is not in the table above cannot be
    // checked against a slot, so it does not get in until somebody measures it.
    for (const dest of BAR) {
      if (!dest.label) continue;
      expect(DP_AT_10PX[dest.label], `${dest.label} has not been measured`).toBeGreaterThan(0);
    }
  });
});

describe("the width that decided there would be five", () => {
  test("seven did not fit, and the first notch of the text size is what spent it", () => {
    /*
     * The claim the old layout made, re-derived rather than repeated. "Terminal"
     * is no longer in the bar as a word, so this is a check on the history: it
     * is why the bar is the shape it is, and if the numbers stop supporting it
     * the shape should be argued again rather than inherited.
     */
    const at360 = slot(360, 7);
    expect(at360).toBeCloseTo(41.43, 2);
    const terminal = DP_AT_10PX.Terminal!;
    expect(terminal).toBeLessThan(at360);          // it fitted…
    expect(at360 - terminal).toBeLessThan(2.5);    // …by two dp
    // 115% is Android's first notch above 100. Both of the two longest words
    // lose it there on a 360dp phone.
    expect(terminal * 1.15).toBeGreaterThan(at360);
    // And on the 411.4dp emulator this was looked at on, the second notch does.
    expect(terminal * 1.15).toBeLessThan(slot(411.4, 7));
    expect(terminal * 1.3).toBeGreaterThan(slot(411.4, 7));
  });

  test("five leaves every label room past the top of Android's scale", () => {
    /*
     * Android's text-size setting tops out at 200% for accessibility; 130% is
     * the last notch of the ordinary slider. The bar is not required to look
     * good at 200% — very little does — but it must not be the first thing to
     * break, and the tightest word in it is "Review" on a 360dp phone at 194%.
     * Everything else has more: 239% on the same phone for "Chats", and every
     * label clears 227% on the 411dp emulator this was looked at on.
     *
     * Nineteen notches of headroom, against the two dp the seven-tab bar had.
     */
    for (const phone of PHONES) {
      const room = slot(phone, BAR.length);
      for (const dest of BAR) {
        if (!dest.label) continue;
        const width = DP_AT_10PX[dest.label]!;
        const breaks = room / width;
        expect(breaks,
          `"${dest.label}" on a ${phone}dp phone ellipsises at ${(breaks * 100).toFixed(0)}% text size`)
          // 1.9 rather than 2.0, because "Review" at 360dp is 1.94 and that is
          // the measurement rather than a target. Past the ordinary slider's
          // top notch by half again is what this is guarding.
          .toBeGreaterThan(1.9);
      }
    }
  });
});

describe("nothing was deleted to get to five", () => {
  const dir = join(import.meta.dir, "..", "app", "(tabs)");
  const routes = readdirSync(dir)
    .filter((f) => /\.tsx$/.test(f) && f !== "_layout.tsx")
    .map((f) => f.replace(/\.tsx$/, "") as TabRoute)
    .sort();

  test("the seven screens this app had are all still there", () => {
    // By file name, because a screen that was quietly folded into another one
    // is exactly the failure this whole task was told not to commit.
    for (const was of ["now", "chats", "terminal", "prs", "repos", "tasks", "settings"]) {
      expect(routes, `${was} is gone`).toContain(was as TabRoute);
    }
  });

  test("every route is either in the bar or has a door written down", () => {
    const known = new Set<TabRoute>([...BAR.map((d) => d.route), ...OFF_BAR.map((o) => o.route)]);
    const orphans = routes.filter((r) => !known.has(r));
    expect(orphans, `${orphans.join(", ")} — reachable from nothing. Add it to BAR or OFF_BAR.`)
      .toEqual([]);
    // And the other direction: a door onto a route that no longer exists.
    const dead = [...known].filter((r) => !routes.includes(r));
    expect(dead, `${dead.join(", ")} — a destination with no screen`).toEqual([]);
  });

  test("every off-bar route says what opens it", () => {
    for (const off of OFF_BAR) {
      expect(off.from, `${off.route} has no way in`).toMatch(/\S/);
      expect(off.title, `${off.route} has no title`).toMatch(/\S/);
    }
    // Now and Settings are entered and left; the other two are drawn in place
    // by Review and are never navigated to, so they need no way back.
    expect([...PUSHED].sort()).toEqual(["now", "settings"]);
  });

  test("the two that are entered draw a way back", () => {
    // The bar can return you to any of its own five. These two it cannot, so
    // the layout has to — checked in the source because there is no navigator
    // to run here.
    const source = readFileSync(join(dir, "_layout.tsx"), "utf8");
    for (const route of PUSHED) {
      expect(source, `${route} has no headerLeft`)
        .toMatch(new RegExp(`name="${route}"[\\s\\S]{0,140}?headerLeft`));
    }
  });
});
