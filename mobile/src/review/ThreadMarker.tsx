/*
 * A conversation, unopened, under the line it is about.
 *
 * The diff is eleven-point monospace at 22 points a row, and a thread card
 * dropped into the middle of it unasked would bury the code the thread is
 * about. So it starts as one line: who said it, roughly what, and how many
 * replies came after — enough to decide whether to open it, which is the only
 * decision a marker is for.
 *
 * It takes the full 44-point target even though the rows around it are 22.
 * The line under it is a line of code and has the argument written in
 * test/tap-floor.test.ts; this is a control, and a mis-tap on a control that
 * expands a card is a card that covers what you were reading.
 */
import { Pressable, Text } from "react-native";
import type { PrThread } from "../../../shared/types.ts";
import { threadDigest } from "../model/threads.ts";
import { TAP } from "../ui.tsx";
import { C, SPACE, T, tint } from "../theme.ts";

const FACE: Record<"open" | "outdated" | "resolved", string> = {
  open: C.primary,
  outdated: C.text4,
  resolved: C.success,
};

export function ThreadMarker({ thread, open, onPress }: {
  thread: PrThread;
  open: boolean;
  onPress: () => void;
}): React.ReactNode {
  const { who, gist, replies, state } = threadDigest(thread);
  const accent = FACE[state];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${state} thread from ${who}${replies ? `, ${replies} replies` : ""}`}
      onPress={onPress}
      style={{
        flexDirection: "row", alignItems: "center", gap: SPACE.sm,
        minHeight: TAP, paddingRight: SPACE.md, paddingLeft: SPACE.sm,
        // Indented past the number column, so the strip starts where the code
        // does and reads as hanging off that line rather than off the file.
        marginLeft: 38,
        backgroundColor: tint(accent, 0.1),
        borderLeftWidth: 3, borderLeftColor: accent,
      }}
    >
      <Text style={{ color: C.text, fontSize: T.eyebrow, fontWeight: "700" }} numberOfLines={1}>
        {who}
      </Text>
      <Text style={{ color: C.text3, fontSize: T.eyebrow, flex: 1 }} numberOfLines={1}>
        {state === "resolved" ? "resolved · " : state === "outdated" ? "outdated · " : ""}{gist}
      </Text>
      {replies ? (
        <Text style={{ color: C.text4, fontSize: T.eyebrow }}>
          {replies === 1 ? "1 reply" : `${replies} replies`}
        </Text>
      ) : null}
      <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{open ? "⌄" : "›"}</Text>
    </Pressable>
  );
}
