/*
 * Which computer this is, in the header of every destination, and the way to
 * another one.
 *
 * It stands where the screen's title stood: the tab bar already says which
 * destination this is, and which computer is the question a phone with two of
 * them cannot answer by looking at a terminal. One tap opens the one sheet.
 *
 * `colors` is the palette of the header it sits in — the terminal's own, as
 * UsageChip's is.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useAgentglass } from "../state/host-context.tsx";
import { useComputer } from "../state/use-computer.ts";
import { displayName, statusOf, waitingElsewhere } from "../model/computers.ts";
import { C, SPACE, T, type Palette } from "../theme.ts";
import { Glyph } from "./glyphs.tsx";
import { ComputerSheet } from "./ComputerSheet.tsx";
import { statusColor } from "./computer-dot.ts";

export function ComputerChip({ colors = C, compact }: { colors?: Palette; compact?: boolean }): React.ReactNode {
  const K = colors;
  const { host, hosts, live, waiting, states } = useAgentglass();
  const said = useComputer(host);
  const [open, setOpen] = useState(false);
  if (!host) return null;
  const name = displayName(host, said);
  const status = statusOf(host, true, live);
  const elsewhere = waitingElsewhere({ active: host.id, hosts }, waiting, states);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Switch computer. Now ${name}`}
        onPress={() => setOpen(true)}
        hitSlop={4}
        style={({ pressed }) => ({
          minHeight: 48, flexShrink: 1, flexDirection: "row", alignItems: "center", gap: SPACE.sm,
          paddingHorizontal: compact ? SPACE.sm : SPACE.md,
          backgroundColor: pressed ? K.bg3 : "transparent", borderRadius: 24,
        })}
      >
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: statusColor(status, K) }} />
        <Text numberOfLines={1} style={{ color: K.text, fontSize: compact ? T.body : T.title, fontWeight: "600", flexShrink: 1 }}>
          {name}
        </Text>
        <Glyph name="down" color={K.text3} size={18} />
        {elsewhere > 0 ? (
          <View
            accessibilityLabel={`${elsewhere} waiting on your other computers`}
            style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: "center", justifyContent: "center", backgroundColor: K.warning }}
          >
            <Text style={{ color: K.bg, fontSize: 12, fontWeight: "700" }}>{elsewhere}</Text>
          </View>
        ) : null}
      </Pressable>
      <ComputerSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
