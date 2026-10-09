/*
 * What is narrowing the list, under the search box: one removable chip per
 * facet that wraps (never a sideways scroller), how many rows it leaves, and
 * the thing a card filter silently does to the rows with no card.
 */
import { Pressable, Text, View } from "react-native";
import { Glyph } from "../nav/glyphs.tsx";
import { Note } from "../ui.tsx";
import type { ActiveChip } from "../model/prFilters.ts";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";

export function PrActiveFilters({ chips, onRemove, onClear, shown, total, more, hidden, onShowHidden }: {
  chips: ActiveChip[];
  onRemove: (id: ActiveChip["id"]) => void;
  onClear: () => void;
  /** Rows the filters keep, of `total` loaded (after the state split). */
  shown: number;
  total: number;
  /** More pages exist, so `total` is what is loaded and not what there is. */
  more: boolean;
  /** Rows with no linked card, which a card filter leaves out: 0 when the
   *  filter is off or they were let through. */
  hidden: number;
  onShowHidden: () => void;
}): React.ReactNode {
  if (!chips.length) return null;
  return (
    <View style={{ paddingHorizontal: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.sm }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm }}>
        {chips.map((c) => (
          <Pressable
            key={c.id}
            accessibilityRole="button"
            accessibilityLabel={`Remove filter ${c.label}`}
            onPress={() => onRemove(c.id)}
            style={({ pressed }) => ({
              minHeight: 48, flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingLeft: SPACE.md,
              paddingRight: SPACE.sm, borderRadius: RADIUS.md, backgroundColor: tint(C.primary, 0.14), opacity: pressed ? 0.6 : 1,
              maxWidth: "100%",
            })}
          >
            <Text numberOfLines={1} style={{ color: C.primary, fontSize: T.small, fontWeight: "700", flexShrink: 1 }}>{c.label}</Text>
            <Glyph name="close" color={C.primary} size={14} weight={2.4} />
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md }}>
        <View style={{ flex: 1 }}>
          <Note>
            {shown} of {total}{more ? " loaded" : ""}
            {hidden ? ` · ${hidden} without a linked card can't match a card filter` : ""}
          </Note>
        </View>
        <Pressable accessibilityRole="button" onPress={onClear} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}>
          <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "700" }}>Clear all</Text>
        </Pressable>
      </View>
      {hidden ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Show the ${hidden} pull request${hidden === 1 ? "" : "s"} without a linked card`}
          onPress={onShowHidden}
          style={({ pressed }) => ({
            minHeight: 52, flexDirection: "row", alignItems: "center", gap: SPACE.md, paddingHorizontal: SPACE.md,
            borderRadius: RADIUS.md, borderWidth: 1, borderStyle: "dashed", borderColor: C.border2, opacity: pressed ? 0.6 : 1,
          })}
        >
          <Glyph name="alert" color={C.text3} size={18} />
          <Text style={{ flex: 1, color: C.text3, fontSize: T.small }}>
            {hidden} pull request{hidden === 1 ? "" : "s"} without a linked card {hidden === 1 ? "is" : "are"} hidden by the card filter.
          </Text>
          <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "700" }}>Show</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
