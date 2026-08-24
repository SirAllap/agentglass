/*
 * The navigator: eight screens, five of them in the bar.
 *
 * What this file decides is what is a TAB, and the answer is "everything",
 * including the three the bar does not draw. Now, Repos and Settings could
 * have been pushed onto the root stack instead — that is what a pushed screen
 * normally is — and it would have hidden the bar for as long as you were in
 * one, which puts the terminal two taps away from the screens people leave
 * open. So they are tabs with no tab: mounted here, reached from a gear and
 * the rows under it, and the bar stays up the whole time.
 *
 * The bar itself is src/nav/TabBar.tsx, and which destinations it offers is
 * src/nav/bar.ts. The reasoning about the seven that were here — and the
 * arithmetic that says why they no longer fit — moved into bar.ts with them;
 * the drawn icons and the argument for drawing them at all moved into
 * src/nav/icons.tsx. Nothing about that reasoning was dropped, it stopped
 * living in a layout file that had grown into three files' worth of it.
 */
import { Pressable } from "react-native";
import { Tabs, useRouter } from "expo-router";
import { TabBar } from "../../src/nav/TabBar.tsx";
import { BackIcon, SettingsIcon } from "../../src/nav/icons.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { C, SPACE, T } from "../../src/theme.ts";
import { TAP } from "../../src/ui.tsx";

/** A header button, at the tap target the rest of the app holds itself to.
 *  Square, because both of the two are a single glyph. */
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
      style={({ pressed }) => ({
        width: TAP, height: TAP, alignItems: "center", justifyContent: "center",
        // The header pays its own edge padding on the other side already.
        marginLeft: side === "left" ? -SPACE.sm : 0,
        marginRight: side === "right" ? SPACE.xs : 0,
        opacity: pressed ? 0.6 : 1,
      })}
    >{children}</Pressable>
  );
}

export default function TabsLayout(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const router = useRouter();

  /** The way out of a screen the bar cannot return you to. `back` in a tab
   *  navigator goes to the first route, which is Home — and Home is the only
   *  place either of these two can be opened from, so it is also the right
   *  answer. */
  const back = (
    <HeaderButton label="Back" side="left" onPress={() => router.back()}>
      <BackIcon color={C.text} />
    </HeaderButton>
  );

  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
        headerTitleStyle: { fontSize: T.title },
        sceneStyle: { backgroundColor: C.bg },
      }}
    >
      {/* ── the bar ─────────────────────────────────────────────────────── */}
      <Tabs.Screen
        name="index"
        options={{
          title: "Inbox",
          headerRight: () => (
            <HeaderButton label="Settings" side="right" onPress={() => router.push("/settings")}>
              <SettingsIcon color={C.text} />
            </HeaderButton>
          ),
        }}
      />
      {/* Pull requests and cards were one destination behind a segmented
          control, which was a saving made when the bar was full of screens
          that have since gone. They are two destinations now, and each keeps
          the screen it always had. */}
      {/*
        Every one of these carries the way back, because none of them is drawn
        in a bar any more. `back` in a tab navigator goes to the first route,
        which is the Inbox — and the Inbox is now the only place any of them is
        opened from, so it is also the right answer.
      */}
      <Tabs.Screen name="prs" options={{ title: "Pull requests", headerLeft: () => back }} />
      {/* The terminal draws its own header — it is the one screen that gives
          the pane every point it can, so the navigator's chrome would be
          spending 56 of them on a title. Its back control is in that header. */}
      <Tabs.Screen name="terminal" options={{ title: "Terminal", headerShown: false }} />
      <Tabs.Screen name="issues" options={{ title: "Issues", headerLeft: () => back }} />
      <Tabs.Screen name="tasks" options={{ title: "Cards", headerLeft: () => back }} />
      <Tabs.Screen name="now" options={{ title: "Now", headerLeft: () => back }} />
      <Tabs.Screen name="repos" options={{ title: "Source control", headerLeft: () => back }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", headerLeft: () => back }} />
    </Tabs>
  );
}
