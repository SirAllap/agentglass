/*
 * The bar: three destinations, the terminal first.
 *
 * Written by hand rather than configured, because the stock bar pads each item
 * and centres a label under an icon, and this one draws the active destination
 * as a filled indicator behind its icon — the Material 3 shape, and the one
 * Android people already read as "you are here". Everything else is the stock
 * bar's behaviour reproduced deliberately: the tabPress event a listener can
 * prevent, the labels left free to scale, the bottom inset paid once.
 *
 * ── it was retired, and why it came back ─────────────────────────────────
 * For a while there was no bar: the Inbox was where the app arrived and every
 * other screen was a place it sent you, with a way back in each header. That
 * made every move between two destinations two moves, through a screen nobody
 * came for. The three are peers, and a bar is 64 points plus the gesture inset
 * well spent on peers — and handed back while typing, below.
 *
 * ── the keyboard ─────────────────────────────────────────────────────────
 * The bar is a flex sibling of the scene, so a window that resizes carries it
 * up to sit mid-screen over the list (API 34, photographed) and a window that
 * does not leaves it buried under the keys (API 36, photographed). React
 * Navigation's own answer, `tabBarHideOnKeyboard`, is read inside ITS bar and
 * this app draws its own, so the option is a no-op here and the rule has to be
 * in this file. While a keyboard is up the bar is not drawn at all.
 *
 * ── it draws no numbers ──────────────────────────────────────────────────
 * The bar used to carry gates on Terminal and reviews on PRs. One count has one
 * home, and it is the bell in the header (app/(tabs)/_layout.tsx), which counts
 * the Inbox's rows. A number here would be a second answer to the same
 * question, computed from a different list — the kind of badge that is wrong
 * exactly once and never trusted again. `test/bar-counts-gone.test.ts` reads
 * this file to keep it that way.
 */
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabBarProps } from "expo-router/build/react-navigation/bottom-tabs";
import { useKeyboardShown } from "../state/use-keyboard.ts";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";
import { BOARD_FRAME } from "../model/boardChrome.ts";
import { BAR, type TabRoute } from "./bar.ts";
import { rememberTab } from "./last.ts";
import { useTerminalPalette } from "./barPalette.ts";
import { PrsIcon, TasksIcon, TerminalIcon, type IconProps } from "./icons.tsx";

/** Only the three the bar draws — the compiler is what keeps this in step with
 *  BAR, so a destination added there without a mark does not build. */
const ICON: Record<"terminal" | "prs" | "tasks", (p: IconProps) => React.ReactNode> = {
  terminal: TerminalIcon,
  prs: PrsIcon,
  tasks: TasksIcon,
};

/** The bar's own height above the gesture inset (52, the mock's): the icon,
 *  its label, and the breathing room Material gives both. */
export const BAR_HEIGHT = BOARD_FRAME.nav;

export function TabBar({ state, navigation }: BottomTabBarProps): React.ReactNode {
  const insets = useSafeAreaInsets();
  const typing = useKeyboardShown();
  const here = state.routes[state.index]?.name as TabRoute | undefined;
  /* Under the terminal the bar is the last strip of the pane's surface — see
     barPalette.ts. Everywhere else, the phone's. */
  const desk = useTerminalPalette();
  const K = here === "terminal" && desk ? desk : C;

  useEffect(() => {
    if (here && BAR.some((d) => d.route === here)) rememberTab(here);
  }, [here]);

  if (typing) return null;

  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        backgroundColor: K.bg2,
        borderTopWidth: 1,
        borderTopColor: K.border,
        paddingBottom: insets.bottom,
      }}
    >
      {BAR.map((dest) => {
        const route = state.routes.find((r) => r.name === dest.route);
        if (!route) return null;
        const on = here === dest.route;
        const Icon = ICON[dest.route as keyof typeof ICON];
        const onPress = (): void => {
          const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!on && !event.defaultPrevented) navigation.navigate(route.name, route.params);
        };
        return (
          <Pressable
            key={dest.route}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={dest.label}
            onPress={onPress}
            style={({ pressed }) => ({
              flex: 1, height: BAR_HEIGHT, alignItems: "center", justifyContent: "center", gap: SPACE.xs,
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            <View style={{
              width: 56, height: 28, borderRadius: RADIUS.lg, alignItems: "center", justifyContent: "center",
              backgroundColor: on ? tint(K.primary, 0.22) : "transparent",
            }}>
              {Icon ? <Icon color={on ? K.text : K.text3} size={22} /> : null}
            </View>
            <Text style={{
              color: on ? K.text : K.text3, fontSize: T.small, lineHeight: 16,
              fontWeight: on ? "600" : "500",
            }}>{dest.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
