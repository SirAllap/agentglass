/*
 * The list selector, full width: where the board is ("Orbit / Delivery") over
 * what it is called, and a chevron that says it opens something. One line when
 * nothing says where it sits — the height does not change, so the search row
 * under it never moves when a board is chosen.
 */
import { Pressable, Text, View } from "react-native";
import { Glyph } from "../nav/glyphs.tsx";
import { C, RADIUS, SPACE, T } from "../theme.ts";

export function BoardHeader({ path, name, onPress }: { path: string; name: string; onPress: () => void }): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`List: ${path ? `${path}, ` : ""}${name}. Change list`}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 56, flexDirection: "row", alignItems: "center", gap: SPACE.md, paddingHorizontal: SPACE.md,
        borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border, backgroundColor: pressed ? C.bg3 : C.bg2,
      })}
    >
      <Glyph name="list" color={C.text2} size={20} />
      <View style={{ flex: 1, minWidth: 0 }}>
        {path ? <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.eyebrow }}>{path}</Text> : null}
        <Text numberOfLines={1} style={{ color: C.text, fontSize: 16, fontWeight: "700" }}>{name}</Text>
      </View>
      <Glyph name="down" color={C.text3} size={20} />
    </Pressable>
  );
}
