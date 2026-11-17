/*
 * The row of doors under the window strip, as the approved mock draws it: `⋯`
 * for this pane, then Files, Source control, History, Agents, and the work
 * behind the pane.
 *
 * A row of its own rather than the right-hand end of the tab strip, which is
 * where they were: the strip scrolls, so every door after the last tab sat at a
 * different x on every machine, and with eight windows most of them were off
 * the screen. The mock gives them a fixed row; this is that row.
 *
 * A door with no handler is drawn dim rather than removed, so the row does not
 * change shape when nothing is attached — and it cannot silently do nothing.
 */
import { Pressable, View } from "react-native";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { RADIUS, SPACE, type Palette } from "../theme.ts";
import { TAP } from "../ui.tsx";

export interface Door {
  glyph: GlyphName;
  /** What a screen reader hears. The icon is the whole of the drawing. */
  label: string;
  /** Absent when there is nothing to open it for: the door stays, dimmed. */
  onPress?: () => void;
  /** The one door out of this pane, in the accent. */
  accent?: boolean;
  /** Something here is uncommitted. */
  dot?: boolean;
}

export function TerminalDoors({ colors, doors, leading }: {
  colors: Palette;
  doors: readonly Door[];
  /** Drawn at the start of the row, when the row IS the strip (no windows). */
  leading?: React.ReactNode;
}): React.ReactNode {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: SPACE.xs,
      paddingHorizontal: SPACE.sm, borderBottomWidth: 1, borderBottomColor: colors.border,
      backgroundColor: colors.bg,
    }}>
      {leading}
      {doors.map((door) => (
        <Pressable
          key={door.label}
          onPress={door.onPress}
          disabled={!door.onPress}
          accessibilityRole="button"
          accessibilityLabel={door.label}
          accessibilityState={{ disabled: !door.onPress }}
          style={({ pressed }) => ({
            width: TAP, height: TAP, alignItems: "center", justifyContent: "center",
            borderRadius: RADIUS.md,
            backgroundColor: pressed ? colors.bg3 : "transparent",
            opacity: door.onPress ? 1 : 0.4,
            transform: [{ scale: pressed ? 0.94 : 1 }],
          })}
        >
          <Glyph name={door.glyph} color={door.accent ? colors.primary : colors.text2} size={21} />
          {door.dot ? (
            <View style={{
              position: "absolute", top: 10, right: 10, width: 6, height: 6, borderRadius: 3,
              backgroundColor: colors.warning, borderWidth: 1.5, borderColor: colors.bg,
            }} />
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}
