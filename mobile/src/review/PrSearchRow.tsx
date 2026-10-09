/*
 * The search box and, beside it, the button that opens the filter sheet.
 *
 * The button carries how many facets are narrowing the list, so a list that
 * looks short for a reason says so before anybody scrolls it. Both are 48 high
 * and neither moves when the other changes.
 */
import { Pressable, Text, TextInput, View } from "react-native";
import { Glyph } from "../nav/glyphs.tsx";
import { C, ink, RADIUS, SPACE, T } from "../theme.ts";

const H = 48;

export function PrSearchRow({
  value, onChange, active = 0, onFilters, placeholder = "Search title, #number, author, branch", label = "Search pull requests",
}: {
  value: string;
  onChange: (text: string) => void;
  /** How many facets are on. */
  active?: number;
  /** Without it there is no filter button: the card list's sheet uses this row
   *  for its own search, which has nothing to filter. */
  onFilters?: () => void;
  placeholder?: string;
  label?: string;
}): React.ReactNode {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
      <View style={{
        flex: 1, height: H, flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingLeft: SPACE.md,
        borderWidth: 1, borderColor: value ? C.primary : C.border, borderRadius: RADIUS.md, backgroundColor: C.bg2,
      }}>
        <Glyph name="search" color={C.text3} size={20} />
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={C.text4}
          accessibilityLabel={label}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="search"
          style={{ flex: 1, height: H, color: C.text, fontSize: T.body, padding: 0 }}
        />
        {value ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => onChange("")}
            style={{ width: H, height: H, alignItems: "center", justifyContent: "center" }}>
            <Glyph name="close" color={C.text3} size={18} />
          </Pressable>
        ) : null}
      </View>
      {onFilters ? <Pressable
        accessibilityRole="button"
        accessibilityLabel={active ? `Filters, ${active} on` : "Filters"}
        onPress={onFilters}
        style={({ pressed }) => ({
          width: H, height: H, alignItems: "center", justifyContent: "center", borderRadius: RADIUS.md,
          borderWidth: 1, borderColor: active ? C.primary : C.border, backgroundColor: C.bg2, opacity: pressed ? 0.7 : 1,
        })}
      >
        <Glyph name="filter" color={active ? C.primary : C.text2} size={20} />
        {active ? (
          <View style={{
            position: "absolute", top: -6, right: -6, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5,
            backgroundColor: C.primary, alignItems: "center", justifyContent: "center",
          }}>
            <Text style={{ color: ink(C.primary), fontSize: T.eyebrow, fontWeight: "700" }}>{active}</Text>
          </View>
        ) : null}
      </Pressable> : null}
    </View>
  );
}
