/*
 * What just happened, and the way back, over the bottom of the screen.
 *
 * Absolute over the content rather than a strip pushed into it: a strip moves
 * every row under the thumb that has just confirmed something. The thin bar
 * along its foot is the time left to undo, so the action does not vanish
 * without warning. `bottom` is the height of whatever bar the screen keeps
 * there, measured by the screen, so this sits above it and stays tappable (a
 * child outside its parent's bounds gets no touches on Android).
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";
import { Glyph } from "../nav/glyphs.tsx";
import { PANE } from "../../../shared/palettes.ts";
import { C, RADIUS, SPACE, T } from "../theme.ts";

/* Always the dark pane's surface, in either theme: the accent on the Undo link
   is chosen to read on a dark ground, and an inverted light bar made it teal on
   pale grey (measured on the emulator, dark theme). */
const SURFACE = PANE.dark;

export const SNACK_MS = 8000;

export function Snackbar({ text, strong, action, onAction, onDone, bottom }: {
  text: string;
  /** The part of the sentence that is the point, in bold: the new status. */
  strong?: string;
  action?: string;
  onAction?: () => void;
  onDone: () => void;
  bottom: number;
}): React.ReactNode {
  const left = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    left.setValue(1);
    const run = Animated.timing(left, { toValue: 0, duration: SNACK_MS, easing: Easing.linear, useNativeDriver: false });
    run.start(({ finished }) => { if (finished) onDone(); });
    return () => run.stop();
    // A new message restarts the clock; `onDone` is the caller's to keep stable.
  }, [text, strong, left, onDone]);

  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        position: "absolute", left: SPACE.lg, right: SPACE.lg, bottom: bottom + SPACE.sm,
        minHeight: 52, borderRadius: RADIUS.md, backgroundColor: SURFACE.bg3, borderWidth: 1, borderColor: SURFACE.border2, overflow: "hidden",
      }}
    >
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: SPACE.md, paddingLeft: SPACE.lg, minHeight: 50 }}>
        <Glyph name="check" color={SURFACE.text} size={18} />
        <Text style={{ flex: 1, color: SURFACE.text, fontSize: T.body }}>
          {text}{strong ? <Text style={{ fontWeight: "700" }}>{strong}</Text> : null}
        </Text>
        {action && onAction ? (
          <Pressable
            accessibilityRole="button" accessibilityLabel={action} onPress={onAction}
            style={{ minHeight: 48, minWidth: 64, paddingHorizontal: SPACE.lg, justifyContent: "center", alignItems: "center" }}
          >
            <Text style={{ color: C.primary, fontSize: T.body, fontWeight: "700" }}>{action}</Text>
          </Pressable>
        ) : null}
      </View>
      <Animated.View style={{
        height: 2, backgroundColor: C.primary,
        width: left.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
      }} />
    </View>
  );
}
