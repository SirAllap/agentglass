/*
 * The jump strip above the board: five lanes, and what each one holds.
 *
 * Short words, not the column titles: five equal shares of 360dp leave about
 * 68dp a tab, and "Waiting on someone else" is a title, not a tab. The count
 * is the number of cards the filters left in that lane, which is also what the
 * column draws — the two read from the same `count`.
 */
import { Pressable, Text, View } from "react-native";
import { STRIP_H } from "../model/boardChrome.ts";
import type { BoardLane } from "../model/prBoard.ts";
import { STRIP_LABEL } from "../model/prBoard.ts";
import { C, SPACE, T } from "../theme.ts";
import { toneInk } from "../ui.tsx";

export function LaneStrip({ lanes, index, onPick }: {
  lanes: BoardLane[];
  /** Which lane the board is showing. */
  index: number;
  onPick: (index: number) => void;
}): React.ReactNode {
  return (
    <View
      role="tablist"
      style={{
        flexDirection: "row", height: STRIP_H, paddingHorizontal: SPACE.xs, gap: 0,
        borderBottomWidth: 1, borderBottomColor: C.border,
      }}
    >
      {lanes.map((lane, i) => {
        const on = i === index;
        return (
          <Pressable
            key={lane.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${STRIP_LABEL[lane.id]}, ${lane.count} ${lane.count === 1 ? "pull request" : "pull requests"}`}
            /* The lane's own sentence, where its title row used to be. */
            accessibilityHint={lane.why}
            onPress={() => onPick(i)}
            style={({ pressed }) => ({
              flex: 1, minWidth: 0, minHeight: STRIP_H - 1, flexDirection: "row",
              alignItems: "center", justifyContent: "center",
              gap: 4, paddingHorizontal: 2, opacity: pressed ? 0.7 : 1,
              borderBottomWidth: 2, borderBottomColor: on ? toneInk(lane.tint) : "transparent",
            })}
          >
            <Text numberOfLines={1} style={{ color: on ? C.text : C.text3, fontSize: T.small, fontWeight: "600" }}>
              {STRIP_LABEL[lane.id]}
            </Text>
            <Text style={{ color: on ? C.primary : C.text4, fontSize: T.eyebrow, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
              {lane.count}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
