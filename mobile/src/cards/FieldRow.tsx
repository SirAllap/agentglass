/*
 * One row of the card's field block: a label, its value, and what the row does.
 *
 * The slot is the same in every state. A writable row shows a chevron and
 * opens a sheet; one the phone may not change shows a lock in the same place
 * and does nothing; one mid-write shows a spinner there. The label and the
 * value never move, so a thumb that found Status once finds it again, and the
 * rows under it (assignees next) are built on the same frame.
 */
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ChevronIcon } from "../nav/icons.tsx";
import { Glyph } from "../nav/glyphs.tsx";
import { C, SPACE, T } from "../theme.ts";

export type FieldTrail = "chevron" | "lock" | "busy" | null;

/** The label column, the same width for every row of a block. */
const LABEL_W = 84;
/** The trailing slot, reserved even when empty so the value never shifts. */
const TRAIL_W = 20;

export function FieldRow({ label, children, trail, onPress, accessibilityLabel }: {
  label: string;
  children: ReactNode;
  trail: FieldTrail;
  /** Absent when the row does nothing: locked, or not known yet. */
  onPress?: () => void;
  accessibilityLabel?: string;
}): ReactNode {
  const body = (pressed: boolean): ReactNode => (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: SPACE.md, minHeight: 56,
      paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm,
      backgroundColor: pressed ? C.bg3 : "transparent",
    }}>
      <Text style={{ width: LABEL_W, color: C.text3, fontSize: T.small, fontWeight: "600" }}>{label}</Text>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" }}>{children}</View>
      <View style={{ width: TRAIL_W, alignItems: "center" }}>
        {trail === "chevron" ? <ChevronIcon color={C.text3} size={18} /> : null}
        {trail === "lock" ? <Glyph name="lock" color={C.text3} size={16} /> : null}
        {trail === "busy" ? <ActivityIndicator size="small" color={C.text3} /> : null}
      </View>
    </View>
  );
  if (!onPress) return <View accessible accessibilityLabel={accessibilityLabel}>{body(false)}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress}>
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}
