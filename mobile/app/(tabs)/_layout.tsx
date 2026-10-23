/*
 * The navigator: four destinations in the bar, two screens that are not.
 *
 * Source control and Settings are tabs with no tab rather than screens pushed
 * on the root stack, because a push hides the bar for as long as you are in
 * one — and both are screens people leave open and come back from.
 *
 * The bar is src/nav/TabBar.tsx and which destinations it offers is
 * src/nav/bar.ts, which also says why the Inbox, Now and the More sheet that
 * held Now, Source control and Settings are gone.
 *
 * ── the header ───────────────────────────────────────────────────────────
 * The computer's name, with a way to another, where the title was; and on the
 * right of every destination, the usage chip and the gear.
 * Settings used to sit behind a `···` sheet with two other screens, which was
 * three taps to a switch and a menu whose name said nothing about what was in
 * it. Everything that belongs to one screen stays on that screen, the way the
 * terminal keeps its own menu.
 */
import { Pressable, View } from "react-native";
import { Tabs, useRouter } from "expo-router";
import { TabBar } from "../../src/nav/TabBar.tsx";
import { BackIcon, SettingsIcon } from "../../src/nav/icons.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { C, SPACE, T } from "../../src/theme.ts";
import { TAP } from "../../src/ui.tsx";
import { UsageChip } from "../../src/usage/Usage.tsx";
import { ComputerChip } from "../../src/nav/ComputerChip.tsx";

/** A header button, at the tap target the rest of the app holds itself to. */
function HeaderButton({ label, onPress, side, children }: {
  label: string;
  onPress: () => void;
  side: "left" | "right";
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: TAP, height: TAP, alignItems: "center", justifyContent: "center",
        // The header pays its own edge padding on the other side already.
        marginLeft: side === "left" ? -SPACE.sm : 0,
        marginRight: side === "right" ? SPACE.xs : 0,
        borderRadius: TAP / 2,
        backgroundColor: pressed ? C.bg3 : "transparent",
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >{children}</Pressable>
  );
}

export default function TabsLayout(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const router = useRouter();

  /* What is left of the plan, then the gear. The chip is on every
     destination because the question it answers is asked right before starting
     something long, from wherever that is — see src/usage/Usage.tsx. */
  const trailing = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.xs }}>
      <UsageChip />
      <HeaderButton label="Settings" side="right" onPress={() => router.push("/settings")}>
        <SettingsIcon color={C.text2} size={22} />
      </HeaderButton>
    </View>
  );

  /** The way out of a screen the bar does not return you to. `back` pops to
   *  whichever destination opened it, which is the tab history's job. */
  const back = (
    <HeaderButton label="Back" side="left" onPress={() => router.back()}>
      <BackIcon color={C.text} size={22} />
    </HeaderButton>
  );

  /* The computer's name stands where the screen's title stood: the bar already
     says which destination this is. */
  const destination = {
    headerTitle: () => <ComputerChip />,
    headerRight: () => trailing,
    headerTitleAlign: "left" as const,
  };

  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      backBehavior="history"
      screenOptions={{
        headerStyle: { backgroundColor: C.bg },
        headerShadowVisible: false,
        headerTintColor: C.text,
        headerTitleStyle: { fontSize: T.head, fontWeight: "600" },
        sceneStyle: { backgroundColor: C.bg },
      }}
    >
      {/* Draws nothing: forwards to where the app was last left. */}
      <Tabs.Screen name="index" options={{ headerShown: false }} />
      {/* The terminal draws its own header — it is the one screen that gives
          the pane every point it can, and its header is about the pane. */}
      <Tabs.Screen name="terminal" options={{ title: "Terminal", headerShown: false }} />
      <Tabs.Screen name="prs" options={{ title: "Pull requests", ...destination }} />
      <Tabs.Screen name="issues" options={{ title: "Issues", ...destination }} />
      <Tabs.Screen name="tasks" options={{ title: "Cards", ...destination }} />
      <Tabs.Screen name="repos" options={{ title: "Source control", headerLeft: () => back }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", headerLeft: () => back }} />
    </Tabs>
  );
}
