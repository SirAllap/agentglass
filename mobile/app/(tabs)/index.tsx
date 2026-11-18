/*
 * Where the app lands, and nothing else.
 *
 * `/` has to be a route: expo-router opens the app on it and the pairing screen
 * replaces itself with it. It used to be the Inbox. Now it reads which
 * destination was last open and forwards there — the terminal when there is
 * none — and draws only the background while the keystore answers, which is the
 * same order of milliseconds as the splash that was just hidden.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Redirect } from "expo-router";
import { BAR, launchRoute, type TabRoute } from "../../src/nav/bar.ts";
import { readLastTab } from "../../src/nav/last.ts";
import { C } from "../../src/theme.ts";

export default function Launch(): React.ReactNode {
  const [to, setTo] = useState<TabRoute | null>(null);

  useEffect(() => {
    let alive = true;
    void readLastTab().then((stored) => { if (alive) setTo(launchRoute(stored, BAR)); });
    return () => { alive = false; };
    // Read once. A destination added to the bar later must not move somebody
    // off a screen they have already started using.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!to) return <View style={{ flex: 1, backgroundColor: C.bg }} />;
  return <Redirect href={`/${to}`} />;
}
