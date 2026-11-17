import { Pressable, Text, View } from "react-native";
import { Glyph } from "../nav/glyphs.tsx";
import { ChevronIcon } from "../nav/icons.tsx";
import { TAP } from "../ui.tsx";
import { C, RADIUS, SPACE, T } from "../theme.ts";

/** One row of the read-only page: a thing that is still a door, and the word
 *  for what it can do with it. */
export function DoorRow({ glyph, title, sub, tag, onPress }: {
  glyph: "folder" | "branch" | "bell";
  title: string;
  sub: string;
  tag?: string;
  onPress?: () => void;
}): React.ReactNode {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${sub}`}
      accessibilityState={{ disabled: !onPress }}
      style={({ pressed }) => ({
        minHeight: TAP, flexDirection: "row", alignItems: "center", gap: SPACE.md,
        paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm,
        borderTopWidth: 1, borderTopColor: C.border,
        backgroundColor: pressed ? C.bg3 : "transparent", opacity: onPress ? 1 : 0.5,
      })}
    >
      <View style={{
        width: 34, height: 34, borderRadius: RADIUS.md, alignItems: "center", justifyContent: "center",
        backgroundColor: C.bg3,
      }}>
        <Glyph name={glyph} color={C.text2} size={16} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={2} style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>{title}</Text>
        <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>{sub}</Text>
      </View>
      {tag ? (
        <View style={{
          height: 24, paddingHorizontal: SPACE.sm, justifyContent: "center",
          borderRadius: RADIUS.sm, borderWidth: 1, borderColor: C.border2,
        }}>
          <Text style={{ color: C.text2, fontSize: T.small }}>{tag}</Text>
        </View>
      ) : null}
      <ChevronIcon color={C.text3} size={18} />
    </Pressable>
  );
}
