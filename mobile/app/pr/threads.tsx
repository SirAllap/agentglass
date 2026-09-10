/*
 * The conversations, as a route.
 *
 * The screen itself is `src/review/ThreadsPane.tsx`, for the same reason the
 * diff's is a pane: a notification points here, and the review shows the same
 * list under a segment. One implementation, two ways in.
 */
import { Stack, useLocalSearchParams } from "expo-router";
import { ThreadsPane } from "../../src/review/ThreadsPane.tsx";

export default function ThreadsScreen(): React.ReactNode {
  const { number, root } = useLocalSearchParams<{ number: string; root: string }>();
  return (
    <>
      <Stack.Screen options={{ title: `#${number} · threads` }} />
      <ThreadsPane number={number ?? ""} root={root ?? ""} />
    </>
  );
}
