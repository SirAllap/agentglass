/*
 * The header of a status section: the workspace's colour, the status as it
 * spells it, and how many cards are under it — the desk board's own grouping.
 */
import { Text, View } from "react-native";
import { statusInk } from "../model/cardStatus.ts";
import { C, SPACE, T, tint } from "../theme.ts";

export function SectionHead({ label, color, count }: { label: string; color?: string; count: number }): React.ReactNode {
  const ink = (color && /^#[0-9a-f]{6}$/i.test(color) ? statusInk(color) : undefined) ?? C.text3;
  return (
    <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingTop: SPACE.lg, paddingBottom: SPACE.sm }}>
      <View style={{
        flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 8,
        backgroundColor: tint(ink, 0.18),
      }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ink }} />
        <Text style={{ color: C.text, fontSize: T.eyebrow, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" }}>{label}</Text>
      </View>
      <Text style={{ color: C.text3, fontSize: T.small, fontVariant: ["tabular-nums"] }}>{count}</Text>
    </View>
  );
}
