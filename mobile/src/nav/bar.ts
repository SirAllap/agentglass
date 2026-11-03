/*
 * Where the app can be gone to, and which of those places the bar offers.
 *
 * Data, with no React in it, because the shape of the navigation is the thing
 * worth locking down and a component is not checkable — see test/nav.test.ts,
 * which asserts the arithmetic below rather than repeating it.
 *
 * ── four peers, and the terminal first ────────────────────────────────────
 * The app used to open on an Inbox: a heading, three counters and a list of
 * the other screens. It was built as the hub the rest hung off, and in use it
 * was the screen between you and the one you came for. The phone is opened to
 * look at an agent, a pull request, an issue or a card, and those four are
 * peers somebody moves between — which is what a bar is for, and what the
 * Inbox's list of destinations was a slower copy of.
 *
 * So the bar is back, and the Inbox, the Now screen and the More sheet that
 * held Now, Source control and Settings are gone:
 *
 *   What the Inbox counted is on the bar itself: a gate waiting on you is a
 *   number on Terminal and a review requested of you is a number on PRs, both
 *   from lists the phone already holds (see TabBar.tsx for why issues and
 *   cards carry none).
 *
 *   Now's gates waiting on you are answered where the agent is, in the terminal — and
 *   on a phone that may not type, the Terminal screen is where they are
 *   listed instead of a pane.
 *
 *   Source control and Files belong to a checkout, so they open from the
 *   terminal's menu, in the checkout that pane is in. Settings is the gear on
 *   every destination's header.
 *
 * ── the width rule ───────────────────────────────────────────────────────
 * The bar is drawn by hand (TabBar.tsx) and each item is an equal share of the
 * width with no padding of its own, so a label has screen / N to live in. At
 * seven, react-navigation's own bar left "Terminal" 41.4dp on a 360dp phone and
 * it lost that at Android's first text-size notch; the five-item bar that
 * followed was sized against the same arithmetic. Four is the count now, the
 * labels are 12 points instead of 10, and test/nav.test.ts holds every word to
 * a measured width.
 */

/** A route file under app/(tabs)/, which is also its path. */
export type TabRoute = "index" | "terminal" | "prs" | "issues" | "tasks" | "repos" | "settings";

export interface Destination {
  route: TabRoute;
  /** The word under the icon. */
  label: string;
}

/** The bar, in the order it is drawn. The terminal is first because it is what
 *  the phone is opened for, and first is where the app lands. */
export const BAR: Destination[] = [
  { route: "terminal", label: "Terminal" },
  { route: "prs", label: "PRs" },
  { route: "issues", label: "Issues" },
  { route: "tasks", label: "Cards" },
];

/**
 * The bar, given what this machine tracks work in.
 *
 * A machine that tracks work NOWHERE has no cards, and a destination that can
 * only say "nothing is connected" costs a tap to learn nothing.
 *
 * ── unknown draws it ─────────────────────────────────────────────────────
 * `null` is not "no". The same choice `visibleTaskSources` makes at the desk,
 * and for the same reason: a spare item is recoverable by ignoring it, and one
 * that is missing because an answer never arrived is not recoverable at all
 * from the device looking at the screen.
 *
 * ── a broken provider keeps its item ─────────────────────────────────────
 * Decided in model/taskProviders.ts, which counts `error` as set up. "ClickUp
 * refused this token" is not "you do not use ClickUp", and the Cards screen is
 * the only surface that was going to say so.
 */
export function taskDestinations(all: Destination[], tracksWork: boolean | null): Destination[] {
  return tracksWork === false ? all.filter((d) => d.route !== "tasks") : all;
}

/**
 * Where the app opens: the last destination somebody was on, if it is still
 * one this phone is offered, and the terminal otherwise.
 *
 * The terminal is offered to every pairing. A phone that may not type sees the
 * gates it can answer there, or that it may only look — see the Terminal
 * screen's own gate — rather than losing the destination, because "where are
 * the agents" is a question every pairing asks.
 */
export function launchRoute(stored: string | null, offered: Destination[]): TabRoute {
  const hit = offered.find((d) => d.route === stored);
  return hit ? hit.route : "terminal";
}

/**
 * The routes that are still routes and are not in the bar.
 *
 * Mounted in the same navigator as the four above, which is what keeps the bar
 * on screen while you are in one. `from` is not documentation: a destination
 * nothing opens is a destination nobody can reach, and the test asserts that
 * every route under app/(tabs)/ is either in the bar or has a way in written
 * down here.
 */
export const OFF_BAR: { route: TabRoute; title: string; from: string }[] = [
  { route: "index", title: "Launch", from: "the app opening: it forwards to launchRoute and draws nothing" },
  { route: "repos", title: "Source control", from: "the terminal's menu, for the checkout that pane is in" },
  { route: "settings", title: "Settings", from: "the gear on every destination's header" },
];

/** The two that are entered and left rather than switched between, so they
 *  are the two that draw a way back. The bar returns you to the other four. */
export const PUSHED: TabRoute[] = ["repos", "settings"];
