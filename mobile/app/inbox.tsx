/*
 * The Inbox: everything waiting on you, in one list.
 *
 * It is a pushed screen rather than a destination, because it is a place you go
 * FROM — every row ends somewhere else (the terminal, a pull request, a plan's
 * Go). That is also why it is not in the bar: three destinations are the work,
 * and the bell that opens this is the answer to "is anything waiting".
 *
 * The list and the bell read one snapshot (src/state/use-inbox.ts); the count
 * on the bell is `items.length`, so what is said and what is drawn cannot
 * disagree.
 */
import { View } from "react-native";
import { Stack } from "expo-router";
import { InboxList } from "../src/inbox/InboxList.tsx";
import { useAgentglass } from "../src/state/host-context.tsx";
import { usePaletteTick } from "../src/state/use-palette.ts";
import { useInbox } from "../src/state/use-inbox.ts";
import { C, SPACE } from "../src/theme.ts";

export default function InboxScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host, fleet } = useAgentglass();
  const { items, missing, loading, reload, plans, agents, ack } = useInbox(host, fleet);

  if (!host) return null;
  return (
    <View style={{ flex: 1, backgroundColor: C.bg, padding: SPACE.lg, paddingTop: SPACE.sm }}>
      <Stack.Screen options={{ title: "Inbox" }} />
      <InboxList
        items={items}
        missing={missing}
        loading={loading}
        host={host}
        plans={plans}
        agents={agents}
        onAnswered={reload}
        onReload={reload}
        onAck={ack}
      />
    </View>
  );
}
