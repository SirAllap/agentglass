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
import { nameOf } from "../model/computers.ts";
import { Btn, Card, Chip } from "../ui.tsx";
import { C, SPACE, T } from "../theme.ts";

export function ComputerGone({ children }: { children: React.ReactNode }): React.ReactNode {
  const { host, live, fleet, refresh, forgetComputer } = useAgentglass();
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
