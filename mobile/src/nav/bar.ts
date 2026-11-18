/*
 * Where the app can be gone to, and which of those places the bar offers.
 *
 * Data, with no React in it, because the shape of the navigation is the thing
 * worth locking down and a component is not checkable — see test/nav.test.ts,
 * which asserts the arithmetic below rather than repeating it.
 *
 * ── three peers, and the terminal first ───────────────────────────────────
 * The app used to open on an Inbox: a heading, three counters and a list of
 * the other screens. It was built as the hub the rest hung off, and in use it
 * was the screen between you and the one you came for. The phone is opened to
 * look at an agent, a pull request or a piece of work, and those three are
 * peers somebody moves between — which is what a bar is for.
 *
 * It went to four (a separate Issues destination), and it is three again.
 * GitHub issues are work, and work lives in Tasks: one destination with a
 * source pill (Jira · GitHub Issues · ClickUp/Taskwarrior) is the shape the
 * mock draws and the one a thumb can hold at 360dp. `app/(tabs)/issues.tsx`
 * stays as a redirect into Tasks, because links and notifications still land
 * there.
 *
 * ── where the numbers went ───────────────────────────────────────────────
 * The bar used to carry two: gates on Terminal and reviews requested on PRs.
 * Both moved to the bell in the header, beside the usage chip and the gear,
 * and the bar carries none. One count, one home: a badge on a bar item and a
 * bell two centimetres above it disagree eventually, and the one a person
 * believes is whichever they looked at first.
 *
 * ── the width rule ───────────────────────────────────────────────────────
 * The bar is drawn by hand (TabBar.tsx) and each item is an equal share of the
 * width with no padding of its own, so a label has screen / N to live in. At
 * seven, react-navigation's own bar left "Terminal" 41.4dp on a 360dp phone and
 * it lost that at Android's first text-size notch; the five-item bar that
 * followed was sized against the same arithmetic. Three is the count now, the
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
  { route: "tasks", label: "Tasks" },
];

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
 * Mounted in the same navigator as the three above, which is what keeps the bar
 * on screen while you are in one. `from` is not documentation: a destination
 * nothing opens is a destination nobody can reach, and the test asserts that
 * every route under app/(tabs)/ is either in the bar or has a way in written
 * down here.
 */
export const OFF_BAR: { route: TabRoute; title: string; from: string }[] = [
  { route: "index", title: "Launch", from: "the app opening: it forwards to launchRoute and draws nothing" },
  {
    route: "issues",
    title: "Issues",
    from: "a redirect into Tasks under the GitHub issues source — links and notifications land there",
  },
  { route: "repos", title: "Source control", from: "the terminal's menu, for the checkout that pane is in" },
  { route: "settings", title: "Settings", from: "the gear on every destination's header" },
];

/** The two that are entered and left rather than switched between, so they
 *  are the two that draw a way back. The bar returns you to the other three. */
export const PUSHED: TabRoute[] = ["repos", "settings"];
