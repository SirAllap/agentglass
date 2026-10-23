/*
 * The two small marks the chip and the sheet both draw: the dot for whether a
 * computer answers, and the count of what waits on a person on one.
 */
import { Text, View } from "react-native";
import type { ComputerStatus } from "../model/computers.ts";
import { C, T, ink, type Palette } from "../theme.ts";

/** Green only for a computer that answered; grey for one nobody has asked yet
 *  or that is not answering (the card under the header says which); red for
 *  one that took this phone off its list. */
export function StatusDot({ status, colors = C }: { status: ComputerStatus; colors?: Palette }): React.ReactNode {
  const K = colors;
  const fill = status === "online" ? K.success : status === "removed" ? K.error : K.text4;
  return <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: fill }} />;
}

export function CountBadge({ n, colors = C, label }: { n: number; colors?: Palette; label?: string }): React.ReactNode {
  const K = colors;
  return (
    <View
      accessibilityLabel={label}
      style={{
        minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6,
        alignItems: "center", justifyContent: "center", backgroundColor: K.warning,
      }}
    >
      <Text style={{ color: ink(K.warning), fontSize: T.eyebrow, fontWeight: "700" }}>{n > 99 ? "99+" : n}</Text>
    </View>
  );
}
