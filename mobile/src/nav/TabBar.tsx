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
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import type { BottomTabBarProps } from "expo-router/build/react-navigation/bottom-tabs";
import { BAR, type TabRoute } from "./bar.ts";
import {
  InboxIcon, IssuesIcon, PrsIcon, TasksIcon, TerminalIcon, type IconProps,
} from "./icons.tsx";
import { useKeyboardShown } from "../state/use-keyboard.ts";
import { usePaletteTick } from "../state/use-palette.ts";
import { C, ink } from "../theme.ts";

/** The bar's own height, above the gesture inset. */
const BAR_H = 56;
/** How far the star's circle rises over the bar's top edge. */
const LIFT = 16;
const STAR_D = 50;
/** The ring that marks the star as the screen you are on. A ring AROUND the
 *  circle with the surface showing through the gap, not a border on it: the
 *  circle IS the accent, so a border drawn in the accent is invisible and one
 *  drawn in anything else is a second colour. The same trick, for the same
 *  reason, as the accent picker's swatches in settings.tsx. */
const RING_D = STAR_D + 8;
/** The label, at the size every number in bar.ts is computed against.
 *
 *  Ten, which is under theme.ts's floor of twelve and is the one place in the
 *  app that goes there. It is the stock bar's own size, it is what the width
 *  arithmetic is written against, and it scales with the phone's setting like
 *  everything else — a label that ignored somebody's accessibility setting to
 *  stay inside its slot would be the worse trade. */
const LABEL_PX = 10;

/** Only the five the bar draws — the compiler is what keeps this in step with
 *  BAR, so a destination added there without a mark does not build. */
const ICONS: Record<Exclude<TabRoute, "now" | "repos" | "settings">,
  (props: IconProps) => React.ReactNode> = {
    index: InboxIcon,
    prs: PrsIcon,
    terminal: TerminalIcon,
    issues: IssuesIcon,
    tasks: TasksIcon,
  };

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

export function TabBar({ state, navigation, insets }: BottomTabBarProps): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const keyboard = useKeyboardShown();

  /** The stock bar's own press, kept: a screen may listen for `tabPress` and
   *  prevent it, and re-navigating to the tab you are already on is what resets
   *  a stack the app does not have yet but will. */
  const go = useCallback((name: string, key: string, focused: boolean): void => {
    const event = navigation.emit({ type: "tabPress", target: key, canPreventDefault: true });
    if (!focused && !event.defaultPrevented) navigation.navigate(name);
  }, [navigation]);

  const at = (route: TabRoute): { key: string; focused: boolean } | null => {
    const index = state.routes.findIndex((r) => r.name === route);
    if (index < 0) return null; // a route file that was renamed — draw nothing
    return { key: state.routes[index]!.key, focused: state.index === index };
  };

  const star = BAR.find((d) => d.star);
  const starAt = star ? at(star.route) : null;

  /*
   * Out of the way while somebody is typing.
   *
   * This is `tabBarHideOnKeyboard`, which this app cannot switch on: the
   * option is read inside React Navigation's own BottomTabBar (line 121 of it)
   * and we hand the navigator a bar of our own, so setting it would have been
   * a line that did nothing.
   *
   * It is also the third shape of one bug. The bar is a flex sibling of the
   * scene, so where it ends up is decided by whether Android resized the
   * window for the keyboard — and that answer changed. MEASURED, same app,
   * same keyboard: on API 34 the window shrank and the bar rode up to sit
   * mid-screen with the star overlapping the list, which is what he
   * photographed; on API 36 the window did not move and the bar stayed at the
   * bottom, buried under the keys. Two opposite pictures, one cause. Standing
   * down while the keyboard is up is the answer to both, and it is the same
   * picture on either Android.
   */
  if (keyboard) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{ height: LIFT + BAR_H + insets.bottom }}
    >
      {/* The surface, drawn under the row rather than around it, so the star
          can sit half on it and half off it. */}
      <View style={{
        position: "absolute", left: 0, right: 0, bottom: 0,
        height: BAR_H + insets.bottom,
        backgroundColor: C.bg2,
        borderTopWidth: 1, borderTopColor: C.border,
      }} />

      <View
        role="tablist"
        style={{
          position: "absolute", left: 0, right: 0, bottom: insets.bottom,
          height: BAR_H, flexDirection: "row",
        }}
      >
        {BAR.map((dest) => {
          const here = at(dest.route);
          // The star's slot is a hole in the row: the circle is drawn in the
          // overlay below, where it has the height to rise out of the bar.
          if (dest.star || !here) return <View key={dest.route} style={{ flex: 1 }} />;
          const Icon = ICONS[dest.route as keyof typeof ICONS];
          const tint = here.focused ? C.primary : C.text4;
          return (
            <Pressable
              key={dest.route}
              accessibilityRole="tab"
              accessibilityState={{ selected: here.focused }}
              accessibilityLabel={dest.label}
              onPress={() => go(dest.route, here.key, here.focused)}
              style={({ pressed }) => ({
                flex: 1,
                alignItems: "center",
                justifyContent: "flex-end",
                paddingBottom: 7,
                gap: 3,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Icon color={tint} />
              <Text
                numberOfLines={1}
                style={{
                  fontSize: LABEL_PX,
                  color: tint,
                  fontWeight: here.focused ? "700" : "500",
                }}
              >{dest.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* The star. Its own overlay, at the top of a container that is LIFT
          taller than the bar, so it is inside its parent's bounds the whole
          way up. */}
      {star && starAt ? (
        <View
          pointerEvents="box-none"
          style={{ position: "absolute", left: 0, right: 0, top: 0, height: RING_D, alignItems: "center" }}
        >
          <View style={{
            width: RING_D, height: RING_D, borderRadius: RING_D / 2,
            alignItems: "center", justifyContent: "center",
            borderWidth: 2, borderColor: starAt.focused ? C.primary : "transparent",
          }}>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: starAt.focused }}
              // Spoken, because there is no label under it. The bar's other
              // four say their own word out loud; this one has to be told.
              accessibilityLabel="Terminal"
              onPress={() => go(star.route, starAt.key, starAt.focused)}
              style={({ pressed }) => ({
                width: STAR_D, height: STAR_D, borderRadius: STAR_D / 2,
                alignItems: "center", justifyContent: "center",
                backgroundColor: pressed ? C.primaryHover : C.primary,
                // Android's own shadow. It is what makes "raised" read as
                // raised rather than as a coloured circle that happens to
                // overlap the bar.
                elevation: 6,
                shadowColor: "#000", shadowOpacity: 0.3,
                shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
              })}
            >
              {/* Measured against the face rather than assumed dark: the face
                  is the accent, and on a light screen with the neutral accent
                  it is #1f2328. See inkOn in shared/palettes.ts. */}
              <TerminalIcon color={ink(C.primary)} size={26} />
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}
