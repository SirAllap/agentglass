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
 */
import { Text, View } from "react-native";
import { useAgentglass } from "../state/host-context.tsx";
import { saidName } from "../state/use-computer.ts";
import { displayName } from "../model/computers.ts";
import { Btn, Card } from "../ui.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";

export function ComputerGone({ children }: { children: React.ReactNode }): React.ReactNode {
  const { host, live, fleet, refresh, forgetComputer } = useAgentglass();
  const removed = !!host?.revoked;
  const offline = !removed && live === "offline" && !!fleet.error;
  if (removed && host) {
    const name = displayName(host, saidName(host.origin));
    return (
      <View style={{ flex: 1, padding: SPACE.lg }}>
        <Card style={{ gap: SPACE.md }}>
          <Pill text="Removed" />
          <Text style={{ color: C.text, fontSize: T.title, fontWeight: "600" }}>{name} took this phone off its list</Text>
          <Text style={{ color: C.text3, fontSize: T.body, lineHeight: 22 }}>
            Someone removed this phone at the computer, so its key no longer works. Forget it here, then add it again if you want it back.
          </Text>
          <Btn label={`Forget ${name}`} tone="danger" onPress={() => { void forgetComputer(host.id); }} />
        </Card>
      </View>
    );
  }
  const name = host ? displayName(host, saidName(host.origin)) : "This computer";
  return (
    <>
      {offline ? (
        <View style={{ padding: SPACE.lg }}>
          <Card style={{ gap: SPACE.md }}>
            <Pill text="Not answering" />
            <Text style={{ color: C.text, fontSize: T.title, fontWeight: "600" }}>{name} is not answering</Text>
            <Text style={{ color: C.text3, fontSize: T.body, lineHeight: 22 }}>
              It may be asleep or on another network. The phone keeps trying.
            </Text>
            <Btn label="Try now" tone="primary" onPress={refresh} />
          </Card>
        </View>
      ) : null}
      <View style={{ flex: 1, display: offline ? "none" : "flex" }}>{children}</View>
    </>
  );
}

function Pill({ text }: { text: string }): React.ReactNode {
  return (
    <View style={{ alignSelf: "flex-start", borderRadius: RADIUS.pill, paddingHorizontal: SPACE.sm, paddingVertical: 2, backgroundColor: tint(C.error, 0.16) }}>
      <Text style={{ color: C.error, fontSize: T.small, fontWeight: "600" }}>{text}</Text>
    </View>
  );
}
