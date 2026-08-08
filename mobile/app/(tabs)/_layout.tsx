/*
 * The navigator: nine screens, five of them in the bar.
 *
 * What this file decides is what is a TAB, and the answer is "everything",
 * including the four the bar does not draw. Now and Settings could have been
 * pushed onto the root stack instead — that is what a pushed screen normally
 * is — and it would have hidden the bar for as long as you were in one, which
 * puts the terminal two taps away from the two screens people leave open. So
 * they are tabs with no tab: mounted here, reached from a band and a gear, and
 * the bar stays up the whole time.
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
          title: "Home",
          headerRight: () => (
            <HeaderButton label="Settings" side="right" onPress={() => router.push("/settings")}>
              <SettingsIcon color={C.text} />
            </HeaderButton>
          ),
        }}
      />
      <Tabs.Screen name="chats" options={{ title: "Chats" }} />
      <Tabs.Screen name="terminal" options={{ title: "Terminal", headerShown: false }} />
      {/* Review sets its own header title — a segmented control — from inside
          the screen, because only the screen knows which half is showing. */}
      <Tabs.Screen name="review" options={{ title: "Review" }} />
      <Tabs.Screen name="repos" options={{ title: "Repos" }} />

      {/* ── the four the bar does not draw ──────────────────────────────── */}
      <Tabs.Screen name="now" options={{ title: "Now", headerLeft: () => back }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", headerLeft: () => back }} />
      {/* Reachable at /prs and /tasks, and drawn inside Review. Neither needs a
          way back of its own: nothing navigates to them, Review renders them
          in place. They stay declared so the two paths keep working and so the
          screens keep their own titles if anything ever does. */}
      <Tabs.Screen name="prs" options={{ title: "PRs" }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks" }} />
    </Tabs>
  );
}
