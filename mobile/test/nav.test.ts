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
import { BAR, OFF_BAR, PUSHED, launchRoute, taskDestinations, type TabRoute } from "../src/nav/bar.ts";

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
  // ── the four below are BOUNDS, not readings, and the difference matters ──
  //
  // The bar changed on a machine with no Android image and no Roboto on it, so
  // the method above could not be run. What was done instead, because a guess
  // is exactly what this table exists to refuse:
  //
  //   DejaVu Sans (the one real face present) was parsed for its `hmtx`
  //   advances and each of the five measured words laid out in it. The
  //   Roboto/DejaVu ratio came out between 0.8824 ("Review") and 0.9127
  //   ("Repos") — a 3% spread over five words, which is what makes the
  //   calibration worth anything. Each new word is its DejaVu width times the
  //   WIDEST of those ratios, so every number here is an over-estimate.
  //
  // They are marked because the next person should replace them with real
  // readings rather than inherit them. Nothing rests on their precision: the
  // tightest, "Issues", ellipsises at 219% on a 360dp phone against the 194%
  // that "Review" already survives on, so the bar has more headroom than the
  // one this replaced, not less.
  Inbox: 25.26,
  PRs: 16.60,
  Issues: 28.36,
  Cards: 26.27,
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
  test("four destinations, the terminal first", () => {
    // First is where the app lands when it has nothing remembered, and the
    // terminal is what the phone is opened for.
    expect(BAR.map((d) => d.route)).toEqual(["terminal", "prs", "issues", "tasks"]);
  });

  test("every destination carries a label", () => {
    // The star that had none is gone with the odd count that centred it.
    for (const dest of BAR) expect(dest.label, `${dest.route} has no label`).toBeTruthy();
  });

  test("every word in it has been measured", () => {
    // The lock. A destination whose label is not in the table above cannot be
    // checked against a slot, so it does not get in until somebody measures it.
    for (const dest of BAR) {
      expect(DP_AT_10PX[dest.label], `${dest.label} has not been measured`).toBeGreaterThan(0);
    }
  });

  test("a machine that tracks work nowhere loses Cards and nothing else", () => {
    expect(taskDestinations(BAR, false).map((d) => d.route)).toEqual(["terminal", "prs", "issues"]);
    expect(taskDestinations(BAR, null)).toBe(BAR);
  });
});

describe("where the app opens", () => {
  test("where it was left, when that is still offered", () => {
    expect(launchRoute("prs", BAR)).toBe("prs");
    expect(launchRoute("tasks", BAR)).toBe("tasks");
  });

  test("the terminal when nothing was remembered, or it is gone", () => {
    expect(launchRoute(null, BAR)).toBe("terminal");
    // Cards remembered on a machine that has since stopped tracking work.
    expect(launchRoute("tasks", taskDestinations(BAR, false))).toBe("terminal");
    // A value an older build wrote: the Inbox, which no longer exists.
    expect(launchRoute("index", BAR)).toBe("terminal");
    expect(launchRoute("settings", BAR)).toBe("terminal");
  });
});

describe("the width that decided the count", () => {
  test("seven did not fit, and the first notch of the text size is what spent it", () => {
    /*
     * The claim the old layout made, re-derived rather than repeated. It is a
     * check on the history — why the bar was cut from seven — and "Terminal"
     * is the word that decided it then and is the tightest word in it again
     * now, below.
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

  test("four, at twelve points, still leave every label room near the top of Android's scale", () => {
    /*
     * The bar is drawn by hand now (src/nav/TabBar.tsx): each item is an equal
     * share of the width with no padding of its own, and the labels are 12
     * points, not the stock 10. So a label's room is screen / 4 and its width
     * is the 10-point reading above times 1.2.
     *
     * The tightest is "Terminal" on a 360dp phone: 90dp against 47.2, which
     * ellipsises at 191% text size. Android's ordinary slider tops out at 130%.
     * The readings are at weight 500, which is how the three inactive labels
     * are drawn; the active one is 600 and was not measured, and the margin
     * below 191% is what is left for it.
     */
    for (const phone of PHONES) {
      const room = phone / BAR.length;
      for (const dest of BAR) {
        const width = DP_AT_10PX[dest.label]! * 1.2;
        const breaks = room / width;
        expect(breaks,
          `"${dest.label}" on a ${phone}dp phone ellipsises at ${(breaks * 100).toFixed(0)}% text size`)
          .toBeGreaterThan(1.85);
      }
    }
  });
});

describe("every screen is still reachable", () => {
  const dir = join(import.meta.dir, "..", "app", "(tabs)");
  const routes = readdirSync(dir)
    .filter((f) => /\.tsx$/.test(f) && f !== "_layout.tsx")
    .map((f) => f.replace(/\.tsx$/, "") as TabRoute)
    .sort();

  test("the screens that survived the cut are all still there", () => {
    // By file name, because a screen quietly folded into another one is the
    // failure this lock was written to catch.
    //
    // Two names left this list, and both left on purpose rather than by
    // drifting out of it:
    //
    //   `chats` was DELETED, screen and model and tests. It listed sessions by
    //   `sessionTitle`, which falls back to `source_app:id.slice(0,8)` when
    //   there is no title — and hook-only sessions never have one, so on a
    //   real machine it was a list of hex. An agent is read in the terminal it
    //   runs in.
    //
    //   `review` was DISSOLVED, not folded: it was a wrapper that drew `prs`
    //   and `tasks` behind a segmented control, and both of those are now
    //   destinations in their own right. Nothing it showed is gone.
    //
    //   `now` was DISSOLVED too. A gate waiting on you is answered where the agent is,
    //   in the terminal (src/terminal/GateCard.tsx), and on the Terminal
    //   screen of a phone that may answer but not type; the queue's other
    //   cards were pull requests, which are PRs' own rows.
    //
    //   `index` stays as a name and stopped being a screen: it was the Inbox
    //   and is now the launch route that forwards to the last destination.
    for (const was of ["index", "terminal", "prs", "repos", "tasks", "settings", "issues"]) {
      expect(routes, `${was} is gone`).toContain(was as TabRoute);
    }
  });

  test("the three that were removed are really gone, not orphaned", () => {
    // The other direction of the same lock: a deleted screen must not linger
    // as a file nothing points at.
    for (const gone of ["chats", "review", "now"]) {
      expect(routes, `${gone} is still on disk`).not.toContain(gone as TabRoute);
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
    // The launch route is not entered: it forwards and is never on screen.
    expect([...PUSHED].sort()).toEqual(["repos", "settings"]);
  });

  test("the two that are entered draw a way back", () => {
    // The bar can return you to any of its own four. These two it cannot, so
    // the layout has to — checked in the source because there is no navigator
    // to run here.
    const source = readFileSync(join(dir, "_layout.tsx"), "utf8");
    for (const route of PUSHED) {
      expect(source, `${route} has no headerLeft`)
        .toMatch(new RegExp(`name="${route}"[\\s\\S]{0,140}?headerLeft`));
    }
  });
});
