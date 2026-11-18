/*
 * The one number this app draws: the Inbox's own rows, as a bell.
 *
 * It is a component rather than a piece of the tab layout because the terminal
 * draws its own header — it is the one destination that gives the pane every
 * point it can — and the terminal is exactly where somebody wants to know that
 * something is waiting without leaving it. Both headers draw this.
 *
 * The count comes from the same hook the Inbox screen reads
 * (state/use-inbox.ts), so "4 waiting" and four rows cannot disagree. No number
 * is drawn for zero: an empty badge is a thing to squint at, and the bell's
 * silence is the answer.
 */
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useAgentglass } from "../state/host-context.tsx";
import { useInbox } from "../state/use-inbox.ts";
import { C, SPACE, T, ink, type Palette } from "../theme.ts";
import { TAP } from "../ui.tsx";
import { BellIcon } from "./icons.tsx";

export function InboxBell({ colors = C }: { colors?: Palette }): React.ReactNode {
  const router = useRouter();
  const { host, fleet } = useAgentglass();
  const { count } = useInbox(host, fleet);
  const K = colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `Inbox, ${count} waiting` : "Inbox"}
      onPress={() => router.push("/inbox")}
      hitSlop={4}
      style={({ pressed }) => ({
        width: TAP, height: TAP, alignItems: "center", justifyContent: "center",
        marginRight: SPACE.xs, borderRadius: TAP / 2,
        backgroundColor: pressed ? K.bg3 : "transparent",
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <View style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center" }}>
        <BellIcon color={K.text2} size={22} />
        {count > 0 ? (
          <View style={{
            position: "absolute", top: -3, right: -4, minWidth: 16, height: 16, borderRadius: 8,
            paddingHorizontal: 4, alignItems: "center", justifyContent: "center",
            backgroundColor: K.primary, borderWidth: 2, borderColor: K.bg,
          }}>
            <Text style={{ color: ink(K.primary), fontSize: T.eyebrow, fontWeight: "700", lineHeight: 13 }}>
              {count > 99 ? "99+" : count}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
