/*
 * The bar: four destinations and a star.
 *
 * Written by hand rather than configured, for one reason — the terminal is
 * raised, and react-navigation's own bar lays every item out inside its bounds.
 * Everything else here is that bar's behaviour reproduced deliberately: the
 * tabPress event a listener can prevent, the active/inactive tint, the labels
 * left free to scale, the bottom inset paid once.
 *
 * ── the geometry, and what it costs ───────────────────────────────────────
 * The star's circle is 50 points and rises 16 above the bar's top edge, so this
 * component is 16 taller than the bar it draws. A tab bar is a flex sibling of
 * the scenes (see BottomTabView), so those 16 points come off the height of
 * every screen in the app — a line of text, spent on the one control the whole
 * companion exists for. It is not free and it is not hidden.
 *
 * Nothing overflows its parent, which on Android is not a stylistic
 * preference: the circle is NOT a child of the row of items — it is its own
 * absolutely-positioned overlay in a container tall enough to hold it, with
 * `box-none` so only the circle itself catches a touch. A child drawn outside
 * its parent's bounds is clipped on Android often enough that the layout should
 * not depend on it.
 *
 * ── the labels ───────────────────────────────────────────────────────────
 * Left to scale with the phone's text-size setting, at the same 10 points the
 * stock bar uses, and after the move to five there is room for it: 62dp of slot
 * on a 360dp phone against 28.36dp for "Issues", the widest word left. See
 * src/nav/bar.ts for where those numbers come from and test/nav.test.ts for the
 * lock that keeps a longer one out.
 */
/** The bar's own height, above the gesture inset. */
/** How far the star's circle rises over the bar's top edge. */
/** The ring that marks the star as the screen you are on. A ring AROUND the
 *  circle with the surface showing through the gap, not a border on it: the
 *  circle IS the accent, so a border drawn in the accent is invisible and one
 *  drawn in anything else is a second colour. The same trick, for the same
 *  reason, as the accent picker's swatches in settings.tsx. */
/** The label, at the size every number in bar.ts is computed against.
 *
 *  Ten, which is under theme.ts's floor of twelve and is the one place in the
 *  app that goes there. It is the stock bar's own size, it is what the width
 *  arithmetic is written against, and it scales with the phone's setting like
 *  everything else — a label that ignored somebody's accessibility setting to
 *  stay inside its slot would be the worse trade. */

/** Only the five the bar draws — the compiler is what keeps this in step with
 *  BAR, so a destination added there without a mark does not build. */

/*
 * There is no badge on the bar, and its absence is a decision.
 *
 * There was one, and it counted `waitingItems` — the queue's agent rule, which
 * calls a session waiting when it has been quiet between four minutes and
 * twelve hours. The Inbox does not show agents at all now, so that number
 * would have been counting something no screen in the app displays.
 *
 * The obvious replacement is the Inbox's own `needs` count, and it is not free.
 * Pull requests are already on the device (the store fetches them), but issues
 * and cards are two more requests, and putting them in a component that mounts
 * on every screen means making them on every screen. A badge built from the
 * pull requests alone would be cheap and would UNDERCOUNT — silently, by
 * exactly the rows it could not see — and the one thing this app cannot afford
 * is a number nobody believes.
 *
 * So: no badge, until the Inbox's data lives somewhere the bar can read for
 * nothing. The Inbox is the first tab and its three tiles are the count.
 */

import type { BottomTabBarProps } from "expo-router/build/react-navigation/bottom-tabs";

export function TabBar(_props: BottomTabBarProps): React.ReactNode {
  /*
   * Retired, and not deleted.
   *
   * The bar was five destinations a thumb-reach away and it cost 56 points plus
   * the home indicator on every screen — about 90. What made that a fair trade
   * was that the five were PEERS somebody moved between constantly. They are
   * not. The Inbox is where you arrive; the other four are places it sends you.
   * Once it grew a heading, a count, a machine row and a list of destinations,
   * the bar became a second and worse copy of navigation the page already had —
   * and 90 points is four rows of a build log on the one screen people sit on.
   *
   * Every screen carries the way back in its own header instead, which is what
   * `back` in app/(tabs)/_layout.tsx is: in a tab navigator it lands on the
   * first route, and the first route is the Inbox — the only place any of them
   * is opened from now, so it is also the right answer.
   *
   * The component stays because "no bar" is a claim about this app's shape
   * today, not a fact about phones. What made it work is in the comment above:
   * the 50-point circle rising 16 above the edge, the overlay that is not a
   * child of the row because Android will not draw one outside its parent, the
   * width arithmetic that caps the count at five. `BAR` in src/nav/bar.ts is
   * still the list — the Inbox draws its own destinations from it — and the
   * icons are still used. If the five ever become peers again, none of that has
   * to be worked out twice.
   */
  return null;
}
