/*
 * The root, and the one decision it makes: paired, or not yet.
 *
 * Everything in the app needs a computer to talk to, so rather than each
 * screen checking, the router is redirected once here. The third state is the
 * one worth naming — `ready` is false while the keystore is being read, and
 * rendering "not paired" during that frame would send somebody back through a
 * handshake they finished last week.
 */
import "../src/lib/rng.ts"; // installs crypto.getRandomValues — must be first
import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SplashScreen from "expo-splash-screen";
import { HostProvider, useAgentglass } from "../src/state/host-context.tsx";
import { usePaletteTick } from "../src/state/use-palette.ts";
import { C, currentLook } from "../src/theme.ts";

void SplashScreen.preventAutoHideAsync();

function Gate(): React.ReactNode {
  const { host, ready } = useAgentglass();
  const segments = useSegments();
  const router = useRouter();

  // The palette is a mutable module object rather than context, so this is the
  // one place that knows it changed. Subscribing at the root means the whole
  // tree re-reads it — the React-Native equivalent of resetting a CSS variable
  // on :root and letting the cascade do the rest.
  usePaletteTick();

  useEffect(() => {
    if (!ready) return;
    void SplashScreen.hideAsync();
    const onPairing = segments[0] === "pair";
    if (!host && !onPairing) router.replace("/pair");
    if (host && onPairing) router.replace("/");
  }, [host, ready, segments, router]);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={C.primary} />
      </View>
    );
  }

  return (
    <>
      {/* Inside the Gate, not above it: the status bar's icons have to flip
          when the palette does, and only this component is subscribed to that.
          "light" means light icons, which is what a dark surface needs.
          The icons are all this sets. `backgroundColor` was tried and is a
          no-op under edgeToEdgeEnabled — measured in Expo Go, the strip stayed
          #000000 with the prop on — and edge-to-edge is also why an installed
          build has no strip to colour: the app draws under it. */}
      <StatusBar style={currentLook().polarity === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: C.bg },
          headerTintColor: C.text,
          headerTitleStyle: { fontSize: 16 },
          contentStyle: { backgroundColor: C.bg },
          // A back gesture out of the pairing screen would leave the app on a
          // tab that cannot load anything.
          gestureEnabled: !!host,
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ title: "Add this phone", headerShown: false }} />
        {/* The conversation is NOT declared here on purpose.
         *
         * expo-router registers every file under `app/` by itself, and a
         * `<Stack.Screen>` only exists to set options. This one set a title that
         * the screen immediately replaces with the conversation's own — so it was
         * redundant, and a redundant declaration whose name has to match a nested
         * path exactly is a way to break the router for nothing.
         */}
      </Stack>
    </>
  );
}

export default function RootLayout(): React.ReactNode {
  return (
    <SafeAreaProvider>
      <HostProvider>
        <Gate />
      </HostProvider>
    </SafeAreaProvider>
  );
}
