/*
 * The computer, and what this phone is allowed to do to it.
 *
 * Deliberately short. The scope is not editable here and never will be: it was
 * chosen at the computer by somebody looking at the request, and a phone that
 * could widen its own grant would make that choice decorative.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, AppState, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useAgentglass } from "../../src/state/host-context.tsx";
import {
  alertsDeliverable, askForAlerts, notificationsSupported, raise,
  type Blocked, type Delivery,
} from "../../src/notifications/notify.ts";
import { Btn, Card, Label, Note, TAP } from "../../src/ui.tsx";
import {
  ACCENTS, C, MONO, RADIUS, SPACE, T, currentLook, ink, setLook,
  type AccentId, type ThemeMode,
} from "../../src/theme.ts";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { accentFor } from "../../../shared/palettes.ts";
import type { DeviceScope } from "../../../shared/types.ts";

/** The same three words the Remote pane uses, so the phone and the computer
 *  describe one grant the same way. */
const SCOPE: Record<DeviceScope, { name: string; what: string }> = {
  read: {
    name: "Look only",
    what: "Sessions, costs, changes and pull requests. This phone approves nothing.",
  },
  answer: {
    name: "Answer things",
    what: "The above, plus approving a held gate and replying to a running session.",
  },
  full: {
    name: "Everything",
    what: "The terminal, git write, Docker and merging. A grant for a laptop you trust.",
  },
};

/**
 * Why this phone cannot buzz, in the words of somebody who would have to fix it.
 *
 * One sentence each, and each names the thing to go and do. The screen used to
 * have exactly one of these — the Expo Go one — and drew every other reason as
 * a switch that was simply off, or, when the permission had been granted and
 * something after it had failed, as a switch that was ON.
 */
const WHY: Record<Blocked, string> = {
  unsupported:
    "Expo Go does not carry the notifications module on Android. This works in a real installed build.",
  denied:
    "Android is not letting this app post notifications. Turn them on for agentglass in the phone's settings.",
  "channel-off":
    "The «Agent alerts» channel is switched off in Android's settings, so notifications are accepted and never drawn.",
  "setup-failed":
    "Notifications could not be set up on this phone. Nothing will be raised until that succeeds — try again.",
  threw:
    "Android refused the last notification. Nothing was drawn.",
};

function Row({ name, value }: { name: string; value: string }): React.ReactNode {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: SPACE.md }}>
      <Text style={{ color: C.text3, fontSize: T.small }}>{name}</Text>
      <Text style={{ color: C.text2, fontSize: T.small, fontFamily: MONO, flexShrink: 1, textAlign: "right" }}>
        {value}
      </Text>
    </View>
  );
}

/** Dark / Light / System, and the row of accents under it. Split out for
 *  reading, not for state: the palette it draws with is a module singleton and
 *  the screen below is what subscribes to it. */
function Look(): React.ReactNode {
  const look = currentLook();

  const MODES: { id: ThemeMode; name: string }[] = [
    { id: "dark", name: "Dark" },
    { id: "light", name: "Light" },
    { id: "system", name: "System" },
  ];

  return (
    <Card>
      <Label text="Look" />
      <View style={{ flexDirection: "row", gap: SPACE.sm }}>
        {MODES.map((m) => {
          const on = look.mode === m.id;
          return (
            <Pressable
              key={m.id}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => setLook({ mode: m.id })}
              style={{
                flex: 1, minHeight: TAP, alignItems: "center", justifyContent: "center",
                borderRadius: RADIUS.md, borderWidth: 1,
                borderColor: on ? C.primary : C.border,
                backgroundColor: on ? C.primary : C.bg3,
              }}
            >
              <Text style={{
                color: on ? ink(C.primary) : C.text2,
                fontSize: T.body,
                fontWeight: on ? "700" : "500",
              }}>{m.name}</Text>
            </Pressable>
          );
        })}
      </View>
      <Note>
        {look.mode === "system"
          // Named rather than left to be worked out: "System" on a phone whose
          // OS theme is on a schedule means this screen changes at sunset.
          ? `Following the phone, which is ${look.polarity} right now.`
          : "Whatever the phone itself is set to is ignored."}
      </Note>

      {/* Seven across, in one row, and that is the constraint the swatch size
          comes from: 44 is the floor for a tap target and seven of them are
          308 against the 329 this card has inside its padding on the emulator's
          393dp screen. A gap between them does not fit — measured, an 8 put the
          seventh on a line of its own — so the leftover 21 is spread instead. */}
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {ACCENTS.map((a) => {
          const on = look.accent === a.id;
          const face = accentFor(look.polarity, a.id).primary;
          return (
            <Pressable
              key={a.id}
              accessibilityRole="button"
              accessibilityLabel={a.name}
              accessibilityState={{ selected: on }}
              onPress={() => setLook({ accent: a.id })}
              // The swatch is 30 in a 44 box: 44 is the floor for anything you
              // tap (see TAP) and seven 44-wide circles do not fit across a
              // phone, so the target keeps the size and the paint does not.
              style={{ width: TAP, height: TAP, alignItems: "center", justifyContent: "center" }}
            >
              {/* Selected is a ring AROUND the swatch with card background
                  showing through the gap, not a border on it. A border has to
                  be a colour, and there is no colour that works for all seven:
                  drawn in the text colour it disappeared on neutral — measured
                  on the emulator, neutral IS the text colour — and drawn in the
                  accent it is a violet ring on violet. A gap is visible against
                  every one of them because it is the card. */}
              <View style={{
                width: 42, height: 42, borderRadius: 21,
                alignItems: "center", justifyContent: "center",
                borderWidth: 2, borderColor: on ? face : "transparent",
              }}>
                <View style={{
                  width: 30, height: 30, borderRadius: 15,
                  backgroundColor: face,
                  // A hairline on every swatch, for the two that are nearly the
                  // card they sit on: neutral is #e6edf3 on #161b22 and #1f2328
                  // on #f6f8fa, and without it the light one has no edge.
                  borderWidth: 1, borderColor: C.border2,
                }} />
              </View>
            </Pressable>
          );
        })}
      </View>
      <Note>
        The accent paints what reads as live — the terminal's cursor, the tab you are on, a button
        that does something. Neutral is the first one: no colour at all.
      </Note>
    </Card>
  );
}

export default function SettingsScreen(): React.ReactNode {
  /*
   * On the SCREEN and not on the picker below it, which is where this started
   * and is not enough: a tap on a swatch repainted the Look card and left the
   * three cards around it in the old palette — measured on the emulator, a
   * half-light screen. The picker is inside this component, so subscribing here
   * redraws both; subscribing there redraws only itself.
   */
  usePaletteTick();
  const { host, live, fleet, forget } = useAgentglass();
  const router = useRouter();
  /* Straight off the store: a pending gate is the fact, not an interpretation
     of one. Same count the terminal's band draws. */
  const held = fleet.gates.length;
  const [going, setGoing] = useState(false);
  /*
   * Whether an alert can actually be DELIVERED — not whether permission was
   * once granted.
   *
   * The switch used to read `notificationsAllowed()`, an OS permission check,
   * and then disable itself once that came back true. Permission is only one
   * of the three things that have to hold: the module has to be there, the
   * setup has to have worked, and the Android channel has to not have been
   * switched off in system settings. Any of those failing left this drawn ON
   * over a phone that could not buzz — reproduced on the emulator, with "Send
   * a test alert" doing nothing and the shade staying empty.
   */
  const [alerts, setAlerts] = useState<Delivery | null>(null);
  const [asking, setAsking] = useState(false);

  const refresh = useCallback((): void => { void alertsDeliverable().then(setAlerts); }, []);

  // Asked on mount, and again every time the app comes back to the front. The
  // one thing that changes these answers is somebody walking into Android's
  // settings, which is a trip out of this app and back — so coming back IS the
  // event, and there is no other notification of it.
  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") refresh(); });
    return () => sub.remove();
  }, [refresh]);

  const turnOn = useCallback(async (): Promise<void> => {
    setAsking(true);
    // Asked only now, when somebody has actually reached for the switch. An
    // app that asks on first launch — before it has shown what it would
    // notify about — gets "no", and Android will not ask a second time.
    setAlerts(await askForAlerts());
    setAsking(false);
  }, []);

  const onForget = useCallback((): void => {
    Alert.alert(
      "Forget this computer?",
      // Said plainly, because it is the half people get wrong: this drops the
      // phone's copy. The credential stays valid until it is revoked at the
      // computer, and a phone cannot be trusted to revoke itself — a phone that
      // has been taken is exactly the one that will not.
      "This phone will lose its credential and you will pair again to come back. " +
      "To cut it off for good, forget the device at the computer as well.",
      [
        { text: "Keep it", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: () => { setGoing(true); void forget(); },
        },
      ],
    );
  }, [forget]);

  if (!host) return null;

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg }}>
      <Card>
        <Label text="Paired with" />
        <Text style={{ color: C.text, fontSize: T.title, fontWeight: "600" }}>{host.label}</Text>
        <Row name="Address" value={host.origin} />
        <Row
          name="Live"
          value={live === "open" ? "connected" : live === "connecting" ? "connecting…" : "offline"}
        />
        <Row
          name="Last answer"
          value={fleet.at ? new Date(fleet.at).toLocaleTimeString() : "never"}
        />
      </Card>

      <Card>
        <Label text="This phone may" />
        <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>
          {SCOPE[host.scope].name}
        </Text>
        <Note>{SCOPE[host.scope].what}</Note>
        <Note>
          Chosen at the computer while somebody was looking at the request. To change it, forget
          this phone there and pair again.
        </Note>
      </Card>

      <Card>
        <Label text="Alerts" />
        <Pressable
          // Still tappable when it is on: the thing that turns it off is a
          // switch in Android's settings, and the only way back was to
          // reinstall. A tap re-asks the OS.
          onPress={() => { if (!asking && notificationsSupported()) void turnOn(); }}
          disabled={asking || !notificationsSupported()}
          style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md }}
        >
          <View style={{
            width: 18, height: 18, borderRadius: 5,
            borderWidth: 1, borderColor: alerts?.ok ? C.success : C.border2,
            backgroundColor: alerts?.ok ? C.success : "transparent",
          }} />
          <Text style={{ color: C.text, fontSize: T.body, flex: 1 }}>
            {/* "Not available" is kept as its own wording rather than folded
                into the red note below: a build that cannot do this at all is
                a fact about the build, and inviting somebody to tap a row that
                can never come on is the wrong offer. Everything else IS an
                offer — a tap re-asks the OS. */}
            {alerts === null ? "Checking…"
              : alerts.ok ? "This phone may buzz"
              : alerts.why === "unsupported" ? "Not available in this build"
              : "Let this phone buzz"}
          </Text>
        </Pressable>
        <Note>
          A gate holding, a tool that failed, a run that stopped — the same notes the computer
          would put on its own screen, raised here instead.
        </Note>
        {alerts && !alerts.ok ? (
          <Note tone="bad">
            {/* The reason, not a dead switch. Every one of these used to be
                drawn as either "off" or — worse, when the permission was
                granted and something else had failed — as ON. */}
            {WHY[alerts.why]}
          </Note>
        ) : null}
        {alerts && !alerts.ok && alerts.why === "channel-off" ? (
          // The one this app cannot undo from script: an Android channel set to
          // no importance can only be raised in system settings.
          <Btn label="Open Android's settings" onPress={() => { void Linking.openSettings(); }} />
        ) : null}
        <Note>
          {/* Said plainly rather than implied. A companion that claims to watch
              a pocket it cannot reach is worse than one that says where it
              stops. */}
          They arrive over the live connection, so they reach you while the app is running and for
          a while after the screen goes off — not for ever. Android eventually freezes it.
        </Note>
        {alerts?.ok ? (
          <Btn
            label="Send a test alert"
            onPress={() => {
              // Through the real path, with the app in the foreground — which
              // the policy would normally suppress, so this calls `raise`
              // directly. Proving the permission and the channel work is the
              // whole point of the button.
              //
              // And it SAYS what happened. A button that silently does nothing
              // is the exact impression this feature cannot afford to give: it
              // is the one thing somebody presses to decide whether to trust
              // the phone with being told.
              void raise({ title: "agentglass", body: "This is what an alert looks like.", urgency: 1 })
                .then((d) => {
                  setAlerts(d);
                  if (!d.ok) Alert.alert("That alert was not shown", WHY[d.why]);
                });
            }}
          />
        ) : null}
      </Card>

      {/*
        The three things the Inbox no longer carries.

        Each left it for a reason and each is still one tap away. Repos was a
        screen that said "Nothing changed here" most days on a machine that
        works a worktree per pull request, and it was spending a fifth of the
        bar on that. The queue and the plan are both about AGENTS, and the
        Inbox is now only about pull requests, issues and cards.

        The queue also has a louder door: a band appears at the bottom of the
        terminal whenever something is actually held. This row is the one that
        is always here, for when you want to go and look rather than be told.
      */}
      <Card>
        <Label text="Elsewhere" />
        <Row name="Held right now" value={held ? `${held} waiting` : "nothing"} />
        <Btn label="Open the queue" onPress={() => router.push("/now")} />
        <Btn label="Working tree" onPress={() => router.push("/repos")} />
        <Note>
          What an agent is doing is read in the terminal it is running in. The queue is where a
          stopped one is answered.
        </Note>
      </Card>

      <Look />

      <Card>
        <Label text="This device" />
        <Btn label="Forget this computer" tone="danger" busy={going} onPress={onForget} />
      </Card>
    </ScrollView>
  );
}
