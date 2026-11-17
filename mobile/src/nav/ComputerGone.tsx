/*
 * What a destination shows when its computer cannot be reached, or took this
 * phone off its list.
 *
 * One card, with the header and the tab bar left alone so the way to another
 * computer is still under the thumb. A removed computer gets Forget as its only
 * action — its key no longer works, and Try now would only fail again.
 *
 * Offline hides the screen rather than unmounting it: a draft in the terminal's
 * composer survives a Wi-Fi flap. Removed unmounts, because there is nothing to
 * come back to and a hidden screen would go on asking with a key that is dead.
 *
 * "Not answering" needs both the socket down AND the last request failed. The
 * socket starts in "offline" on every cold start, and one signal alone would
 * flash this card before the first answer.
 *
 * `tile` is the terminal's own drawing (s24): no card at all, one object in the
 * middle of the page with the two ways out under it, then the sentence that
 * says nothing was lost. The other destinations keep the card — their headers
 * carry a count and a title the tile would have to repeat.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useAgentglass } from "../state/host-context.tsx";
import { nameOf } from "../model/computers.ts";
import { ComputerSheet } from "./ComputerSheet.tsx";
import { Glyph } from "./glyphs.tsx";
import { Btn, Card, Chip, TAP } from "../ui.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";

export function ComputerGone({ children, tile }: {
  children: React.ReactNode;
  /** The terminal's centred drawing of the same fact. */
  tile?: boolean;
}): React.ReactNode {
  const { host, live, fleet, refresh, forgetComputer } = useAgentglass();
  const [switching, setSwitching] = useState(false);
  const removed = !!host?.revoked;
  const offline = !removed && live === "offline" && !!fleet.error;
  const name = host ? nameOf(host) : "This computer";
  if (removed && host) {
    return (
      <GoneCard
        tag="Removed"
        title={`${name} took this phone off its list`}
        text="Someone removed this phone at the computer, so its key no longer works. Forget it here, then add it again if you want it back."
        action={<Btn label={`Forget ${name}`} tone="danger" onPress={() => { void forgetComputer(host.id); }} />}
      />
    );
  }
  if (offline && tile) {
    return (
      <>
        <View style={{ flex: 1, justifyContent: "center", padding: SPACE.lg, gap: SPACE.lg }}>
          <View style={{ alignItems: "center", gap: SPACE.sm }}>
            <View style={{
              width: 64, height: 64, borderRadius: RADIUS.lg, alignItems: "center", justifyContent: "center",
              backgroundColor: tint(C.error, 0.14),
            }}>
              <Glyph name="offline" color={C.error} size={26} />
            </View>
            <Text style={{ color: C.text, fontSize: T.head, fontWeight: "600", textAlign: "center" }}>
              {`Cannot reach ${name}`}
            </Text>
            <Text style={{ color: C.text3, fontSize: T.body, lineHeight: 22, textAlign: "center" }}>
              The computer may be asleep, or this phone is on another network.
            </Text>
            <Btn label="Try again" tone="primary" onPress={refresh} style={{ marginTop: SPACE.xs, minWidth: 150 }} />
            <Pressable
              onPress={() => setSwitching(true)}
              accessibilityRole="button"
              accessibilityLabel="Switch computer"
              style={({ pressed }) => ({ minHeight: TAP, justifyContent: "center", paddingHorizontal: SPACE.md, opacity: pressed ? 0.6 : 1 })}
            >
              <Text style={{ color: C.text2, fontSize: T.body, fontWeight: "600" }}>Switch computer</Text>
            </Pressable>
          </View>
          <View style={{
            flexDirection: "row", gap: SPACE.sm, padding: SPACE.md, borderRadius: RADIUS.lg,
            backgroundColor: tint(C.warning, 0.14),
          }}>
            <Glyph name="clock" color={C.warning} size={17} />
            <Text style={{ flex: 1, color: C.warning, fontSize: T.small, lineHeight: 18 }}>
              <Text style={{ fontWeight: "700" }}>What you had is still readable.</Text>
              {" "}The board, the pull request you had open and the last terminal output stay on the phone; nothing is lost by waiting.
            </Text>
          </View>
          <Text style={{ color: C.text3, fontSize: T.small, textAlign: "center" }}>
            Retrying every 15 s while this screen is open.
          </Text>
          <ComputerSheet open={switching} onClose={() => setSwitching(false)} />
        </View>
        {/* Hidden, never unmounted: a draft in the composer outlives a Wi-Fi
            flap, which is the whole reason this branch draws over the screen
            rather than replacing it. */}
        <View style={{ flex: 1, display: "none" }}>{children}</View>
      </>
    );
  }
  return (
    <>
      {offline ? (
        <GoneCard
          tag="Not answering"
          title={`${name} is not answering`}
          text="It may be asleep or on another network. The phone keeps trying."
          action={<Btn label="Try now" tone="primary" onPress={refresh} />}
        />
      ) : null}
      <View style={{ flex: 1, display: offline ? "none" : "flex" }}>{children}</View>
    </>
  );
}

function GoneCard({ tag, title, text, action }: {
  tag: string; title: string; text: string; action: React.ReactNode;
}): React.ReactNode {
  return (
    <View style={{ padding: SPACE.lg }}>
      <Card style={{ gap: SPACE.md }}>
        <View style={{ alignSelf: "flex-start" }}><Chip label={tag} tone="bad" /></View>
        <Text style={{ color: C.text, fontSize: T.title, fontWeight: "600" }}>{title}</Text>
        <Text style={{ color: C.text3, fontSize: T.body, lineHeight: 22 }}>{text}</Text>
        {action}
      </Card>
    </View>
  );
}
