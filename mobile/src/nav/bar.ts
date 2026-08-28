/*
 * Where the app can be gone to, and which of those places the bar offers.
 *
 * Data, with no React in it, because the shape of the navigation is the thing
 * worth locking down and a component is not checkable — see test/nav.test.ts,
 * which asserts the arithmetic below rather than repeating it.
 *
 * ── the width rule, which has not changed ─────────────────────────────────
 * A tab bar hands each item the screen width over N, less the 10 points of
 * padding BottomTabItem puts inside it (5 a side — the number is in
 * expo-router's own copy of it, views/BottomTabItem.js). At seven that is
 * 41.4dp of label on a 360dp phone, and "Terminal" at 39.30dp lost it at
 * Android's FIRST text-size notch. Five is what that arithmetic bought, and
 * five is still the count.
 *
 * ── why the five are no longer the same five ──────────────────────────────
 * The bar used to be Home / Chats / ★ / Review / Repos, and three of those
 * were answering a question this app is no longer being asked.
 *
 *   Chats is GONE, screen and all. It listed conversations by
 *   `sessionTitle`, which falls back to `source_app:id.slice(0,8)` when a
 *   session carries no title — and hook-only sessions never do, so on a real
 *   machine it was a list of hex. What replaced it is not another screen: an
 *   agent is read in the terminal it is running in, which is what the star
 *   has always been for.
 *
 *   Review is GONE as a destination, and its two halves are promoted. It
 *   existed to hold pull requests and cards behind one segmented control,
 *   which was a saving made when the bar was full. It is not full now.
 *
 *   Repos leaves the bar. It is the working tree — stage, commit, push — and
 *   on a machine that works a worktree per pull request it says "Nothing
 *   changed here" most days. That is a screen worth having and not a screen
 *   worth a fifth of the bar.
 *
 * ── and why THESE five ────────────────────────────────────────────────────
 * Inbox, pull requests, issues and cards are one claim: the four things this
 * phone is for are the work waiting on you and the three places it comes
 * from. Issues had no screen at all before — the server has answered
 * `/issues/list` the whole time and nothing on the phone ever asked.
 *
 * The star keeps the middle. With the chat gone it is the only place an agent
 * runs, so everything handed to Claude lands one tap from every screen.
 */

/** A route file under app/(tabs)/, which is also its path. */
export type TabRoute =
  | "index" | "prs" | "terminal" | "issues" | "tasks"
  | "now" | "repos" | "settings";

export interface Destination {
  route: TabRoute;
  /** The word under the icon. Absent on the star, which has none — see below. */
  label?: string;
  /** Centred, raised and in the primary colour: the reason this app exists.
   *  It carries no label, and that is not a saving: the circle is the only
   *  coloured, raised, 50-point thing in the bar, TalkBack still names it, and
   *  a word under it would be the one the arithmetic above cannot afford. */
  star?: true;
}

/** The bar, in the order it is drawn. The star is the middle of an odd number
 *  of items or it is not centred — test/nav.test.ts holds that. */
export const BAR: Destination[] = [
  { route: "index", label: "Inbox" },
  { route: "prs", label: "PRs" },
  { route: "terminal", star: true },
  { route: "issues", label: "Issues" },
  { route: "tasks", label: "Cards" },
];

/**
 * The destinations the Inbox offers, given what this machine tracks work in.
 *
 * `BAR` is the claim about what this app is for and stays whole — it is the
 * list, the test's subject, and the thing `index.tsx` draws from. This is the
 * one question laid over it: a machine that tracks work NOWHERE has no cards,
 * and a row that opens a screen which can only say "nothing is connected" is a
 * row that costs a tap to learn nothing.
 *
 * ── why this removes rather than replaces ────────────────────────────────
 * There is nothing to replace it with. When these five were a bottom bar the
 * count had to stay odd or the star was not centred, and losing one meant
 * promoting another; that bar is retired (src/nav/TabBar.tsx) and the Inbox
 * draws a LIST, which has no such arithmetic. Source control was added to the
 * list the moment the slot stopped existing, so the destination that would
 * have been promoted is already here.
 *
 * ── unknown draws it ─────────────────────────────────────────────────────
 * `null` is not "no". The same choice `visibleTaskSources` makes at the desk,
 * and for the same reason: a spare row is recoverable by ignoring it, and a
 * row that is missing because an answer never arrived is not recoverable at
 * all from the device looking at the screen.
 *
 * ── a broken provider keeps its row ──────────────────────────────────────
 * Decided in model/taskProviders.ts, which counts `error` as set up. "ClickUp
 * refused this token" is not "you do not use ClickUp", and the row is the only
 * surface that was going to say so.
 */
export function taskDestinations(all: Destination[], tracksWork: boolean | null): Destination[] {
  return tracksWork === false ? all.filter((d) => d.route !== "tasks") : all;
}

/**
 * The routes that are still routes and are no longer tabs.
 *
 * Every one of them is a whole screen, mounted in the same navigator as the
 * five above — which is what keeps the bar on screen while you are in one, and
 * therefore keeps the terminal one tap away from all eight. A push onto the
 * root stack would have hidden the bar and made it two.
 *
 * `from` is not documentation. A destination nothing opens is a destination
 * nobody can reach, and the test asserts that every route under app/(tabs)/ is
 * either in the bar or has a way in written down here.
 */
export const OFF_BAR: { route: TabRoute; title: string; from: string }[] = [
  { route: "now", title: "Now", from: "Settings ▸ Held right now" },
  { route: "repos", title: "Repos", from: "Settings ▸ Working tree" },
  { route: "settings", title: "Settings", from: "the gear in the Inbox header" },
];

/** The three that are entered and left rather than switched between, so they
 *  are the three that draw a way back. The bar can return you to any of the
 *  other five by itself. */
export const PUSHED: TabRoute[] = ["now", "repos", "settings"];
