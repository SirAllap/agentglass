/*
 * The dot on a window: what the agent in it is doing, in a colour.
 *
 * One component for the strip and the switcher, because two drawings of one
 * state are how a teal dot comes to mean "working" on one and "done" on the
 * other. Colours come in as a palette: the strip wears the pane's (the desk's
 * theme), the sheet wears the phone's.
 *
 * `needs` is ringed, not only amber. A colour alone is the one signal a
 * colour-blind thumb cannot read, and "needs you" is the one that matters.
 */
import { View } from "react-native";
import type { Dot } from "./windows.ts";
import { tint } from "../theme.ts";

interface DotColours { primary: string; warning: string; error: string; success: string; text4: string }

const size = 10;

export function StatusDot({ dot, colors }: { dot: Dot; colors: DotColours }): React.ReactNode {
  const fill = dot === "needs" ? colors.warning
    : dot === "error" ? colors.error
    : dot === "working" ? colors.primary
    : dot === "done" ? colors.success
    : dot === "idle" ? colors.text4
    : tint(colors.text4, 0.45);
  const ring = dot === "needs" ? size + 6 : size;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: ring, height: ring, borderRadius: ring / 2, alignItems: "center", justifyContent: "center",
        backgroundColor: dot === "needs" ? tint(colors.warning, 0.28) : "transparent",
      }}
    >
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: fill }} />
    </View>
  );
}
