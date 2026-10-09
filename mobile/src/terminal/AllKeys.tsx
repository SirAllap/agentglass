/*
 * The "All keys" sheet: control chords, movement, symbols and F-keys as a grid
 * of thumb-sized keys. What goes in it, and where its bytes come from, is
 * allKeys.ts; this is only how it is drawn and that a press goes through the
 * caller's own send — the same function the bar's keys use, so a key cannot
 * send one thing from here and another from there.
 */
import { Pressable, Text, View } from "react-native";
import { Glyph } from "../nav/glyphs.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../theme.ts";
import { Sheet, TAP } from "../ui.tsx";
import { ALL_KEYS } from "./allKeys.ts";
import { sendFor, type AccessoryKey } from "./keys.ts";
import { armed, armedTip, type Latches } from "./modifiers.ts";

const COLUMNS = 4;

export function AllKeysSheet({ open, onClose, held, onKey, onEdit }: {
  open: boolean;
  onClose: () => void;
  /** What is latched now: a key with no encoding under it is drawn unavailable. */
  held: Latches;
  onKey: (key: AccessoryKey) => void;
  onEdit: () => void;
}): React.ReactNode {
  const modifiers = armed(held);
  const tip = armedTip(held);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="All keys"
      subtitle="Tap once to send. Modifiers apply to the next key."
      footer={(
        <Pressable
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel="Edit the key bar"
          style={({ pressed }) => ({
            flex: 1, minHeight: TAP, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: SPACE.sm,
            borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border,
            backgroundColor: pressed ? C.bg4 : C.bg3,
          })}
        >
          <Glyph name="sliders" color={C.text} size={20} />
          <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>Edit the key bar</Text>
        </Pressable>
      )}
    >
      {tip ? <Text style={{ color: C.primary, fontSize: T.small, paddingBottom: SPACE.sm }}>{tip}</Text> : null}
      {ALL_KEYS.map((group) => (
        <View key={group.id} style={{ gap: SPACE.sm, paddingBottom: SPACE.md }}>
          <Text accessibilityRole="header" style={{ color: C.text3, fontSize: T.eyebrow, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase", paddingTop: SPACE.xs }}>
            {group.title}
          </Text>
          {chunks(group.keys, COLUMNS).map((row, i) => (
            <View key={i} style={{ flexDirection: "row", gap: SPACE.sm }}>
              {row.map((key) => {
                const sends = sendFor(key, modifiers);
                return (
                  <Pressable
                    key={key.id}
                    disabled={sends === null}
                    accessibilityRole="button"
                    accessibilityLabel={key.spoken}
                    onPress={() => onKey(key)}
                    style={({ pressed }) => ({
                      flex: 1, height: TAP, alignItems: "center", justifyContent: "center",
                      borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border,
                      backgroundColor: pressed ? C.bg4 : C.bg3,
                      opacity: sends === null ? 0.35 : 1,
                    })}
                  >
                    <Text style={{ color: C.text, fontSize: T.body, fontFamily: MONO, fontWeight: "600" }}>{key.label}</Text>
                  </Pressable>
                );
              })}
              {/* The last row of a group keeps its keys their width. */}
              {Array.from({ length: COLUMNS - row.length }, (_, k) => <View key={`pad${k}`} style={{ flex: 1 }} />)}
            </View>
          ))}
        </View>
      ))}
    </Sheet>
  );
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
