/*
 * The bar that counts the lines picked for copying, and copies them.
 *
 * The mock's shape: an inverted pill over the pane, a count on the left, Copy
 * and Done. Inverted on purpose — it is not part of the terminal, it is a mode
 * laid over one, and the pane's own colours are busy saying what the machine is
 * doing.
 *
 * The text itself is not assembled here: select.ts owns what "these lines, in
 * this order" means, and this only says how many there are and what just
 * happened to them.
 */
import { Pressable, Text, View } from "react-native";
import { countWords } from "./select.ts";
import { TAP } from "../ui.tsx";
import { RADIUS, SPACE, T } from "../theme.ts";
import type { Palette } from "../../../shared/palettes.ts";

export function SelectBar({ picked, note, ready, onCopy, onDone, colors }: {
  /** How many lines are picked — the count this shows. */
  picked: number;
  /** What the last Copy said, if anything. */
  note: string | null;
  /** Whether the pane's text has arrived. Copy waits for it: the text is
   *  assembled on this side, and a Copy with no lines behind it is a lie. */
  ready: boolean;
  onCopy: () => void;
  onDone: () => void;
  /** The pane's palette: this bar is laid over the pane, so it reads on it. */
  colors: Palette;
}): React.ReactNode {
  const canCopy = picked > 0 && ready;
  return (
    <View
      accessibilityLabel="Selected lines"
      style={{
        flexDirection: "row", alignItems: "center", gap: SPACE.sm,
        marginHorizontal: SPACE.sm, marginBottom: SPACE.xs, paddingLeft: SPACE.md, paddingRight: SPACE.xs,
        borderRadius: RADIUS.lg, backgroundColor: colors.text,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: colors.bg, fontSize: T.small, fontWeight: "600" }}>
          {picked === 0 ? "Tap lines to select" : countWords(picked)}
        </Text>
        {note ? (
          <Text numberOfLines={1} style={{ color: colors.primary, fontSize: T.eyebrow }}>
            {note}
          </Text>
        ) : ready ? null : (
          <Text numberOfLines={1} style={{ color: colors.primary, fontSize: T.eyebrow }}>
            Reading what this pane holds…
          </Text>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Copy the selected lines"
        disabled={!canCopy}
        onPress={onCopy}
        style={({ pressed }) => ({
          minHeight: TAP, paddingHorizontal: SPACE.md, justifyContent: "center",
          borderRadius: RADIUS.md, backgroundColor: colors.bg,
          opacity: canCopy ? (pressed ? 0.7 : 1) : 0.4,
        })}
      >
        <Text style={{ color: colors.text, fontSize: T.small, fontWeight: "700" }}>Copy</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Leave select mode"
        onPress={onDone}
        style={({ pressed }) => ({
          minHeight: TAP, paddingHorizontal: SPACE.md, justifyContent: "center",
          borderRadius: RADIUS.md, opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text style={{ color: colors.bg, fontSize: T.small, fontWeight: "700" }}>Done</Text>
      </Pressable>
    </View>
  );
}
