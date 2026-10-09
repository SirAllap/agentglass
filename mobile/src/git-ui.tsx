/*
 * The small marks the Git screens share: what happened to a file, how much, and
 * whether you have read it. Source control, the commit and its diff all draw
 * these, and a status letter drawn three ways is three ways to misread it.
 */
import { Pressable, Text, View } from "react-native";
import type { GitFileStatus } from "../../shared/types.ts";
import { Glyph } from "./nav/glyphs.tsx";
import { TAP } from "./ui.tsx";
import { C, MONO, SPACE, T, ink, tint } from "./theme.ts";

/** What happened to a file, as a letter on a tint of its colour. A letter as
 *  well as a colour: at small sizes outdoors, colour alone is not a signal to
 *  rely on, and for a good number of people it is not a signal at all. The
 *  letters are git's own, so the phone and `git status` say the same thing. */
export function mark(status: GitFileStatus["status"]): { letter: string; ink: string; says: string } {
  switch (status) {
    case "added": return { letter: "A", ink: C.success, says: "Added" };
    case "untracked": return { letter: "U", ink: C.success, says: "Untracked" };
    case "deleted": return { letter: "D", ink: C.error, says: "Deleted" };
    case "unmerged": return { letter: "!", ink: C.error, says: "Conflicted" };
    case "renamed": return { letter: "R", ink: C.info, says: "Renamed" };
    case "copied": return { letter: "C", ink: C.info, says: "Copied" };
    default: return { letter: "M", ink: C.warning, says: "Modified" };
  }
}

export function StatusBadge({ status }: { status: GitFileStatus["status"] }): React.ReactNode {
  const m = mark(status);
  return (
    <View style={{
      width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center",
      backgroundColor: tint(m.ink, 0.16),
    }}>
      <Text style={{ color: m.ink, fontSize: T.small, fontWeight: "600", fontFamily: MONO }}>{m.letter}</Text>
    </View>
  );
}

/** `+9 −3`, green and red. The minus is the real one (U+2212), as in a diff. */
export function Stats({ added, removed }: { added: number; removed: number }): React.ReactNode {
  return (
    <Text style={{ fontSize: T.small, fontFamily: MONO }}>
      <Text style={{ color: C.success }}>{`+${added}`}</Text>
      {"  "}
      <Text style={{ color: C.error }}>{`−${removed}`}</Text>
    </Text>
  );
}

/** The tick you give a file you have read. A box, like the staging box, but
 *  not the same colour of meaning: this one changes nothing on the computer. */
export function ViewedBox({ on, path, onPress }: { on: boolean; path: string; onPress: () => void }): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={`${on ? "Viewed" : "Mark as viewed"}: ${path}`}
      onPress={onPress}
      hitSlop={SPACE.sm}
      style={{ width: TAP, height: TAP, alignItems: "center", justifyContent: "center" }}
    >
      <View style={{
        width: 26, height: 26, borderRadius: 7, alignItems: "center", justifyContent: "center",
        borderWidth: on ? 0 : 2, borderColor: C.text4, backgroundColor: on ? C.success : "transparent",
      }}>
        {on ? <Glyph name="check" color={ink(C.success)} size={17} weight={2.6} /> : null}
      </View>
    </Pressable>
  );
}

/** The line under a list that says the list can be pulled. Without it the
 *  gesture is something you either know or never find. */
export function PullHint({ text = "Pull down to refresh." }: { text?: string }): React.ReactNode {
  return (
    <Text style={{ color: C.text3, fontSize: T.small, paddingHorizontal: SPACE.xs, paddingTop: SPACE.md }}>{text}</Text>
  );
}
