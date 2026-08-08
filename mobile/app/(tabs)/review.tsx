/*
 * Review: the things from outside that are waiting on a decision.
 *
 * One destination holding two screens, and the merge is not a saving — it is a
 * claim about what they are. A pull request somebody opened and a card somebody
 * put on the board are the same kind of object from this phone's point of view:
 * neither is your code, both arrived from somewhere else, and both are waiting
 * for you to say something. They were two tabs out of seven, side by side,
 * making the same argument twice.
 *
 * Repos deliberately did NOT join them. That is your own working tree — the
 * files you have changed and not committed — which is not waiting on a decision
 * and is not from outside. Merging on "they are both lists" is how a tab bar
 * ends up with one tab called More.
 *
 * ── the control is in the header ──────────────────────────────────────────
 * Because both halves already carry a strip of their own — repositories on one,
 * the board's saved views on the other — and the pull-request half carries a
 * filter row under that. A third bar above them would put 164 points of chrome
 * over the first card on a phone. The header is already on the screen and its
 * title says a word the tab under it is also saying, so it is the one place
 * here that is genuinely free.
 *
 * ── nothing is unmounted ──────────────────────────────────────────────────
 * A half that has been opened stays mounted and is hidden instead. Each of them
 * fetches on mount — the pull-request half costs a round trip per repository
 * and per filter, GitHub-backed — so a control that tore its screen down would
 * spend that every time somebody tapped back and forth. The half nobody has
 * opened yet is not mounted at all, which is why this is not simply rendering
 * both: opening Review must not ask GitHub anything on behalf of a screen
 * nobody looked at.
 */
import { useLayoutEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useNavigation } from "expo-router";
import PrsScreen from "./prs.tsx";
import TasksScreen from "./tasks.tsx";
import { PrsIcon, TasksIcon } from "../../src/nav/icons.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { C, RADIUS, SPACE, T } from "../../src/theme.ts";

type Half = "prs" | "tasks";

/** Pull requests first, and it is not alphabetical: a pull request waiting on
 *  your review is somebody blocked on you, and a card on a board is somebody
 *  planning. The same argument that puts "My review" first inside the pull
 *  request screen's own filters. */
const HALVES: { id: Half; label: string }[] = [
  { id: "prs", label: "Pull requests" },
  { id: "tasks", label: "Cards" },
];

function Segmented({ on, onPick }: { on: Half; onPick: (half: Half) => void }): React.ReactNode {
  return (
    <View style={{
      flexDirection: "row",
      backgroundColor: C.bg3,
      borderRadius: RADIUS.md,
      padding: 2,
    }}>
      {HALVES.map((half) => {
        const here = half.id === on;
        const Icon = half.id === "prs" ? PrsIcon : TasksIcon;
        return (
          <Pressable
            key={half.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: here }}
            onPress={() => onPick(half.id)}
            style={{
              flexDirection: "row", alignItems: "center", gap: SPACE.xs,
              paddingHorizontal: SPACE.md,
              // Under the 44 floor, and said out loud: this sits in a header
              // that is 56 tall, so 44 plus the header's own padding does not
              // fit. It is a switch between two views rather than an action
              // with a cost — the wrong tap here is undone by tapping again.
              minHeight: 34,
              justifyContent: "center",
              borderRadius: RADIUS.sm,
              backgroundColor: here ? C.bg : "transparent",
              borderWidth: 1,
              borderColor: here ? C.border2 : "transparent",
            }}
          >
            <Icon color={here ? C.primary : C.text4} size={14} />
            <Text style={{
              color: here ? C.text : C.text3,
              fontSize: T.small,
              fontWeight: here ? "600" : "400",
            }}>{half.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function ReviewScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const navigation = useNavigation();
  const [half, setHalf] = useState<Half>("prs");
  /** Which halves have ever been opened — see the header. A half drops out of
   *  the tree only when this screen does. */
  const [opened, setOpened] = useState<Half[]>(["prs"]);

  /*
   * setOptions rather than an inline <Tabs.Screen options={…} />, and the
   * difference is the dependency array. That component's effect keys on the
   * options OBJECT, so an inline literal is a fresh reference on every render
   * and it calls setOptions every time — harmless for a title string, and not
   * something to do with a header that renders a control. This fires when the
   * half changes and not otherwise. The closure reads the palette at header
   * render time, so a theme change still repaints it.
   */
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitleAlign: "center",
      headerTitle: () => (
        <Segmented
          on={half}
          onPick={(next) => {
            setHalf(next);
            setOpened((was) => (was.includes(next) ? was : [...was, next]));
          }}
        />
      ),
    });
  }, [navigation, half]);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {opened.includes("prs") ? (
        <View style={{ flex: 1, display: half === "prs" ? "flex" : "none" }}>
          <PrsScreen />
        </View>
      ) : null}
      {opened.includes("tasks") ? (
        <View style={{ flex: 1, display: half === "tasks" ? "flex" : "none" }}>
          <TasksScreen />
        </View>
      ) : null}
    </View>
  );
}
