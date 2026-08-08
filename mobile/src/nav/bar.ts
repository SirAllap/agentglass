/*
 * Where the app can be gone to, and which of those places the bar offers.
 *
 * Data, with no React in it, because the shape of the navigation is the thing
 * worth locking down and a component is not checkable — see test/nav.test.ts,
 * which asserts the arithmetic below rather than repeating it.
 *
 * ── why there are five, when there were seven ─────────────────────────────
 * A tab bar hands each item the screen width over N, less the 10 points of
 * padding BottomTabItem puts inside it (5 a side — the number is in
 * expo-router's own copy of it, views/BottomTabItem.js). At seven that is
 * 41.4dp of label on a 360dp phone.
 *
 * Measured, rather than guessed: the sum of Roboto's advances for "Terminal" at
 * the bar's 10px, at the weight the label is drawn in, is 39.30dp. That is
 * 2.1dp of headroom, and Android's text-size setting spends it at its FIRST
 * notch — the word ellipsised at 115% on a 360dp screen and at 130% on a 412dp
 * one. ("Settings" was the other one at 37.02dp.) The measurement is the
 * emulator's own /system/fonts/Roboto-Regular.ttf, laid out at wght 500; the
 * method and the table are in test/nav.test.ts.
 *
 * At five the same phone gives 62dp and the widest word left in the bar is
 * "Review" at 31.88dp, which survives to 194% — past the top of Android's own
 * slider and most of the way through its accessibility range. The pressure is
 * gone rather than eased.
 *
 * ── and why these five ────────────────────────────────────────────────────
 * Nothing was dropped to get there. Pull requests and cards are one
 * destination, because they are one thing: items from outside waiting on a
 * decision. Now is reached from the band that replaced it at the top of Home —
 * a screen whose own copy says it "is meant to be empty most of the time" does
 * not deserve to be the first thing anybody sees, but it is still the whole
 * list and it is still one tap in. Settings is the gear in Home's header.
 * Repos does not join Review, on purpose: that is your own code, a different
 * intent.
 */

/** A route file under app/(tabs)/, which is also its path. */
export type TabRoute =
  | "index" | "chats" | "terminal" | "review" | "repos"
  | "now" | "prs" | "tasks" | "settings";

export interface Destination {
  route: TabRoute;
  /** The word under the icon. Absent on the star, which has none — see below. */
  label?: string;
  /** Centred, raised and in the primary colour: the reason this app exists.
   *  It carries no label, and that is not a saving: the circle is the only
   *  coloured, raised, 52-point thing in the bar, TalkBack still names it, and
   *  the word it would have carried is the exact one that did not fit at
   *  seven. */
  star?: true;
}

/** The bar, in the order it is drawn. The star is the middle of an odd number
 *  of items or it is not centred — test/nav.test.ts holds that. */
export const BAR: Destination[] = [
  { route: "index", label: "Home" },
  { route: "chats", label: "Chats" },
  { route: "terminal", star: true },
  { route: "review", label: "Review" },
  { route: "repos", label: "Repos" },
];

/**
 * The routes that are still routes and are no longer tabs.
 *
 * Every one of them is a screen this app already had, kept whole, mounted in
 * the same navigator as the five above — which is what keeps the bar on screen
 * while you are in one, and therefore keeps the terminal one tap away from all
 * nine. A push onto the root stack would have hidden the bar and made it two.
 *
 * `from` is not documentation. A destination nothing opens is a destination
 * nobody can reach, and the test asserts that every route under app/(tabs)/ is
 * either in the bar or has a way in written down here.
 */
export const OFF_BAR: { route: TabRoute; title: string; from: string }[] = [
  { route: "now", title: "Now", from: "the band at the top of Home" },
  { route: "prs", title: "PRs", from: "Review's segmented control" },
  { route: "tasks", title: "Tasks", from: "Review's segmented control" },
  { route: "settings", title: "Settings", from: "the gear in Home's header" },
];

/** The two that are entered and left rather than switched between, so they are
 *  the two that draw a way back. The bar can return you to any of the other
 *  seven by itself. */
export const PUSHED: TabRoute[] = ["now", "settings"];
