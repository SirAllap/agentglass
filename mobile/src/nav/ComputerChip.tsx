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
import { Pressable, Text } from "react-native";
import { useAgentglass } from "../state/host-context.tsx";
import { useComputer } from "../state/use-computer.ts";
import { displayName, statusOf, waitingElsewhere } from "../model/computers.ts";
import { C, SPACE, T, type Palette } from "../theme.ts";
import { Glyph } from "./glyphs.tsx";
import { ComputerSheet } from "./ComputerSheet.tsx";
import { CountBadge, StatusDot } from "./computer-bits.tsx";

export function ComputerChip({ colors = C, compact }: { colors?: Palette; compact?: boolean }): React.ReactNode {
  const K = colors;
  const { host, hosts, live, waiting, states } = useAgentglass();
  const said = useComputer(host);
  const [open, setOpen] = useState(false);
  // Built on first use and kept after, so closing still slides out; up to six
  // chips exist at once and none of them should render five rows while shut.
  const [used, setUsed] = useState(false);
  if (!host) return null;
  const name = displayName(host, said);
  const status = statusOf(host, true, live);
  const elsewhere = waitingElsewhere({ active: host.id, hosts }, waiting, states);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Switch computer. Now ${name}`}
        onPress={() => { setUsed(true); setOpen(true); }}
        hitSlop={4}
        style={({ pressed }) => ({
          minHeight: 48, flexShrink: 1, flexDirection: "row", alignItems: "center", gap: SPACE.sm,
          paddingHorizontal: compact ? SPACE.sm : SPACE.md,
          backgroundColor: pressed ? K.bg3 : "transparent", borderRadius: 24,
        })}
      >
        <StatusDot status={status} colors={K} />
        <Text numberOfLines={1} style={{ color: K.text, fontSize: compact ? T.body : T.title, fontWeight: "600", flexShrink: 1 }}>
          {name}
        </Text>
        <Glyph name="down" color={K.text3} size={18} />
        {elsewhere > 0 ? <CountBadge n={elsewhere} colors={K} label={`${elsewhere} waiting on your other computers`} /> : null}
      </Pressable>
      {used ? <ComputerSheet open={open} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
