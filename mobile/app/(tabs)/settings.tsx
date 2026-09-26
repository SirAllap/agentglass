/*
 * Settings: the computer, and the preferences of this phone.
 *
 * ── what is here, and what left ──────────────────────────────────────────
 * Five groups — Computer, Notifications, Appearance, Terminal, Help — and
 * nothing that is not a setting. The screen used to be three things at once: a
 * settings page, a plan-usage card and a menu of other screens ("Elsewhere":
 * the queue, the working tree). The plan is the chip on every header now, the
 * queue is answered in the terminal, and Source control opens from the
 * terminal it belongs to. What stayed is what somebody comes here to change.
 *
 * The scope is not editable here and never will be: it was chosen at the
 * computer by somebody looking at the request, and a phone that could widen its
 * own grant would make that choice decorative. It is said, in the computer's
 * sheet, with what would change it.
 *
 * The terminal's width and keyboard help moved here from the key bar's screen:
 * they are preferences, and the key bar screen is about the keys.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, AppState, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { since } from "../../src/lib/dates.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { useComputer } from "../../src/state/use-computer.ts";
import {
  alertsDeliverable, askForAlerts, notificationsSupported, raise,
  type Blocked, type Delivery,
} from "../../src/notifications/notify.ts";
import {
  keepAliveAvailable, keepAliveRunning, loadKeepAlivePref, saveKeepAlivePref, syncKeepAlive, wantKeepAlive,
} from "../../src/notifications/keepAlive.ts";
import { onTalkPref, setTalkPref, talkPref, type TalkPref } from "../../src/notifications/talkPref.ts";
import { Btn, Group, GroupTitle, Note, Row, Sheet, Switch, TAP } from "../../src/ui.tsx";
import { Glyph, type GlyphName } from "../../src/nav/glyphs.tsx";
import { KeyboardIcon } from "../../src/nav/icons.tsx";
import {
  ACCENTS, C, MONO, RADIUS, SPACE, T, currentLook, ink, setLook, tint, type ThemeMode,
} from "../../src/theme.ts";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { phonePalette } from "../../../shared/palettes.ts";
import type { DeviceScope } from "../../../shared/types.ts";
import { ACCESSORY_KEYS } from "../../src/terminal/keys.ts";
import { rows as keyRows } from "../../src/terminal/keyLayout.ts";
import { bytesFor } from "../../src/terminal/customKeys.ts";
import {
  COLUMNS, customKeys, keyLayout, onTermPrefs, setTermAssist, setTermColumns, termAssist, termColumns,
} from "../../src/terminal/termPrefs.ts";

/** The same three words the Remote pane uses, so the phone and the computer
 *  describe one grant the same way. `chip` is the short form the computer's
 *  row carries. */
const SCOPE: Record<DeviceScope, { name: string; chip: string; what: string }> = {
  read: {
    name: "Look only",
    chip: "Looks only",
    what: "Sessions, costs, changes and pull requests. This phone approves nothing.",
  },
  answer: {
    name: "Answer things",
    chip: "Answers",
    what: "The above, plus approving a held gate and replying to a running session.",
  },
  full: {
    name: "Everything",
    chip: "Full access",
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

const Lead = ({ name }: { name: GlyphName }): React.ReactNode => <Glyph name={name} color={C.text2} size={20} />;

function Fact({ name, value }: { name: string; value: string }): React.ReactNode {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: SPACE.md, paddingVertical: 6 }}>
      <Text style={{ color: C.text3, fontSize: T.small }}>{name}</Text>
      <Text style={{ color: C.text2, fontSize: T.small, fontFamily: MONO, flexShrink: 1, textAlign: "right" }}>
        {value}
      </Text>
    </View>
  );
}

/** A few options in a pill, at the end of a row. The full-width `Segmented`
 *  is for switching what a screen shows; this is a value on a settings row,
 *  and it sits where a switch would. */
function Pick<V extends string>({ value, options, onChange, label }: {
  value: V;
  options: { id: V; name: string }[];
  onChange: (v: V) => void;
  label: string;
}): React.ReactNode {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{ flexDirection: "row", padding: 3, borderRadius: RADIUS.pill, backgroundColor: C.bg3 }}
    >
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => onChange(o.id)}
            hitSlop={{ top: 4, bottom: 4 }}
            style={({ pressed }) => ({
              minHeight: 36, paddingHorizontal: SPACE.md, borderRadius: RADIUS.pill,
              alignItems: "center", justifyContent: "center",
              backgroundColor: on ? C.primary : "transparent",
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            <Text style={{
              color: on ? ink(C.primary) : C.text2, fontSize: 13, fontWeight: on ? "600" : "500",
            }}>{o.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The accents, in one row.
 *
 * Seven across, and that is the constraint the swatch size comes from: 44 is
 * the floor for a tap target and seven of them are 308 against the 329 a card
 * had inside its padding on the emulator's 393dp screen. A gap between them
 * does not fit — measured, an 8 put the seventh on a line of its own — so the
 * leftover is spread instead.
 */
function Swatches(): React.ReactNode {
  const look = currentLook();
  return (
    <View style={{
      flexDirection: "row", justifyContent: "space-between", paddingHorizontal: SPACE.md, paddingBottom: SPACE.md,
    }}>
      {ACCENTS.map((a) => {
        const on = look.accent === a.id;
        // What will actually be painted, which on the phone is the accent
        // walked to a shade that reads — see phonePalette.
        const face = phonePalette(look.polarity, a.id).primary;
        return (
          <Pressable
            key={a.id}
            accessibilityRole="radio"
            accessibilityLabel={a.name}
            accessibilityState={{ checked: on }}
            onPress={() => setLook({ accent: a.id })}
            style={{ width: TAP, height: TAP, alignItems: "center", justifyContent: "center" }}
          >
            {/* Selected is a ring AROUND the swatch with the card showing
                through the gap, not a border on it. A border has to be a
                colour, and there is no colour that works for all seven: drawn
                in the text colour it disappeared on neutral — measured on the
                emulator, neutral IS the text colour — and drawn in the accent
                it is a violet ring on violet. A gap is visible against every
                one of them because it is the card. */}
            <View style={{
              width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center",
              borderWidth: 2, borderColor: on ? face : "transparent",
            }}>
              <View style={{
                width: 30, height: 30, borderRadius: 15, backgroundColor: face,
                // A hairline on every swatch, for the two that are nearly the
                // card they sit on.
                borderWidth: 1, borderColor: C.border2,
              }} />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The computer: what it is called, where it is, and what this phone may do
 *  to it. A sheet, because it is looked at and dismissed. */
function ComputerSheet({ open, onClose, onForget }: {
  open: boolean;
  onClose: () => void;
  onForget: () => void;
}): React.ReactNode {
  const { host, live, fleet } = useAgentglass();
  const computer = useComputer(host);
  const router = useRouter();
  if (!host) return null;
  const scope = SCOPE[host.scope];
  /* How long ago this pairing was made. Worth a row because the sheet is where
     somebody asks "is this the phone I paired last week, or the one from the
     spring", and the label alone does not say. */
  const ago = since(host.pairedAt, Date.now());
  return (
    <Sheet open={open} onClose={onClose} title={computer}>
      <View style={{ gap: SPACE.md, paddingBottom: SPACE.md }}>
        <View>
          <Fact name="Address" value={host.origin} />
          <Fact name="Connection" value={live === "open" ? "live" : live === "connecting" ? "connecting…" : "offline"} />
          <Fact name="Last answer" value={fleet.at ? new Date(fleet.at).toLocaleTimeString() : "never"} />
          <Fact name="This phone is called" value={host.label} />
          {ago ? <Fact name="Paired" value={ago === "0m" ? "just now" : `${ago} ago`} /> : null}
        </View>
        {/* Copied rather than read out: the address is what gets typed into a
            second phone or a browser at the desk, and a typo in a port is a
            pairing that fails for a reason nobody can see. */}
        <Btn
          label="Copy the address"
          onPress={() => {
            void Clipboard.setStringAsync(host.origin);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}
        />
        <View style={{ gap: SPACE.xs, padding: SPACE.md, borderRadius: RADIUS.lg, backgroundColor: C.bg3 }}>
          <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>{scope.name}</Text>
          <Note>{scope.what}</Note>
          <Note>
            Chosen at the computer while somebody was looking at the request. To change it, forget this
            phone there and pair again.
          </Note>
        </View>
        <Btn label="Troubleshooting" onPress={() => { onClose(); router.push("/troubleshoot"); }} />
        <Btn label="Forget this computer" tone="danger" onPress={() => { onClose(); onForget(); }} />
      </View>
    </Sheet>
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
  const { host, live, forget } = useAgentglass();
  const computer = useComputer(host);
  const router = useRouter();
  const [going, setGoing] = useState(false);
  const [sheet, setSheet] = useState(false);
  const look = currentLook();
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
  /* Android + the native module linked, or the row has nothing to do — see
     keepAlive.ts. Computed once: it does not change for the life of the
     process (there is no "install the module while running"). */
  const [canKeepAlive] = useState(keepAliveAvailable);
  /* Defaults true (see keepAlive.ts) until the keystore answers, so the row
     does not flash off-then-on on every open. What it shows afterwards is
     ACTUAL state, not the preference: see the effect below and
     keepAliveRunning's own comment for why those can differ. */
  const [keepAlive, setKeepAlive] = useState(true);

  /* This phone's own preference for a live comment/review — never sent to the
     server (see talkPref.ts). Mirrored the way termColumns/termAssist are:
     read once at module scope, told when it changes. */
  const [talk, setTalk] = useState<TalkPref>(talkPref);
  useEffect(() => onTalkPref(() => setTalk(talkPref())), []);

  /* The terminal's preferences are module singletons shared with the pane;
     these are the local mirrors that make this screen repaint. */
  const [cols, setCols] = useState(termColumns);
  const [assist, setAssist] = useState(termAssist);
  const [keys, setKeys] = useState(() => ({ layout: keyLayout(), mine: customKeys() }));
  useEffect(() => onTermPrefs(() => {
    setCols(termColumns()); setAssist(termAssist()); setKeys({ layout: keyLayout(), mine: customKeys() });
  }), []);
  const onBar = useMemo(() => keyRows(keys.layout, [
    ...ACCESSORY_KEYS,
    ...keys.mine.map((k) => ({ id: k.id, label: k.label, bytes: bytesFor(k), spoken: k.label })),
  ]).filter((r) => r.shown).length, [keys]);

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

  useEffect(() => {
    if (!canKeepAlive) return;
    // The saved preference decides what host-context.tsx's own sync WANTS;
    // what this switch shows is whatever that sync has actually landed as, by
    // the time this screen asks — not the preference echoed back, which would
    // draw ON through a start() Android refused.
    void loadKeepAlivePref().then(() => { setKeepAlive(keepAliveRunning()); });
  }, [canKeepAlive]);

  const turnOn = useCallback(async (): Promise<void> => {
    setAsking(true);
    // Asked only now, when somebody has actually reached for the switch. An
    // app that asks on first launch — before it has shown what it would
    // notify about — gets "no", and Android will not ask a second time.
    setAlerts(await askForAlerts());
    setAsking(false);
  }, []);

  const toggleKeepAlive = useCallback((on: boolean): void => {
    void saveKeepAlivePref(on);
    // The switch shows what start()/stop() actually did, not the tap: a
    // refused start() (background-start limits, battery restrictions the
    // owner set by hand) draws OFF rather than a switch that lies.
    setKeepAlive(syncKeepAlive(wantKeepAlive({ alertsOk: !!alerts?.ok, pref: on })));
  }, [alerts]);

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

  const supported = notificationsSupported();
  const MODES: { id: ThemeMode; name: string }[] = [
    { id: "system", name: "System" },
    { id: "dark", name: "Dark" },
    { id: "light", name: "Light" },
  ];
  const status = live === "open" ? "Connected" : live === "connecting" ? "Connecting…" : "Offline";

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.xs, paddingBottom: SPACE.xl }}>
      <Group>
        <Row
          title={computer}
          sub={`${status} · ${host.origin.replace(/^https?:\/\//, "")}`}
          lead={
            <View style={{
              width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center",
              backgroundColor: tint(C.primary, 0.16),
            }}>
              <Glyph name="computer" color={C.primary} size={22} />
            </View>
          }
          trail={
            <View style={{
              flexDirection: "row", alignItems: "center", gap: 4, height: 28, paddingHorizontal: 10,
              borderRadius: 14, backgroundColor: tint(C.primary, 0.16),
            }}>
              <Glyph name="shield" color={C.primary} size={14} />
              <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "600" }}>{SCOPE[host.scope].chip}</Text>
            </View>
          }
          chevron
          onPress={() => setSheet(true)}
        />
      </Group>

      <GroupTitle text="Notifications" />
      <Group inset={50}>
        <Row
          title="Agent alerts"
          /* The reason, not a dead switch, when it cannot come on. Every one of
             these used to be drawn as either "off" or — worse, when the
             permission was granted and something else had failed — as ON. */
          sub={alerts === null ? "Checking…"
            : alerts.ok ? "When an agent waits on you, fails or stops"
            : WHY[alerts.why]}
          lead={<Lead name="bell" />}
          checked={!!alerts?.ok}
          trail={<Switch on={!!alerts?.ok} disabled={!supported} />}
          disabled={asking || !supported}
          onPress={() => {
            // On is turned off where Android keeps it: a phone app cannot
            // revoke its own permission, and a switch that flips back by itself
            // is a switch that lies. Off asks the OS.
            if (alerts?.ok) void Linking.openSettings();
            else void turnOn();
          }}
        />
        <View>
          <Row
            title="Comments on your pull requests"
            // This-phone-only, and said so: the preference lives in this
            // phone's keystore (talkPref.ts) rather than at the computer, so
            // pairing a second phone starts it at Off again. Bots never reach
            // this either way — the server drops them before a "talk" note
            // exists (see mapTalk in prs.ts). While alerts cannot be raised
            // the row says what it waits on, not the reason again: that is
            // written on the row above.
            sub={alerts?.ok ? "This phone only, never for a bot. The «new» badges show either way."
              : "Needs agent alerts on first"}
            lead={<Lead name="comment" />}
            disabled={!alerts?.ok}
          />
          {/* Below the text, as the accent swatches are: three options beside
              a title this long truncated it to "Comments on you…". */}
          <View style={{ paddingLeft: 50, paddingRight: SPACE.md, paddingBottom: SPACE.md, alignItems: "flex-start", opacity: alerts?.ok ? 1 : 0.45 }}>
            <Pick<TalkPref>
              value={talk}
              onChange={(v) => { if (alerts?.ok) setTalkPref(v); }}
              label="Comments on your pull requests"
              options={[
                { id: "off", name: "Off" },
                { id: "reviews", name: "Reviews" },
                { id: "everything", name: "All" },
              ]}
            />
          </View>
        </View>
        {alerts && !alerts.ok && alerts.why === "channel-off" ? (
          // The one this app cannot undo from script: an Android channel set to
          // no importance can only be raised in system settings.
          <Row
            title="Open Android's settings"
            lead={<Lead name="external" />}
            onPress={() => { void Linking.openSettings(); }}
          />
        ) : null}
        {alerts?.ok ? (
          <Row
            title="Send a test notification"
            lead={<Lead name="spark" />}
            onPress={() => {
              // Through the real path, with the app in the foreground — which
              // the policy would normally suppress, so this calls `raise`
              // directly. And it SAYS what happened: a button that silently does
              // nothing is the exact impression this feature cannot afford.
              void raise({ title: "agentglass", body: "This is what an alert looks like.", urgency: 1 })
                .then((d) => {
                  setAlerts(d);
                  if (!d.ok) Alert.alert("That alert was not shown", WHY[d.why]);
                });
            }}
          />
        ) : null}
        {alerts?.ok && canKeepAlive ? (
          <Row
            title="Stay connected in the background"
            sub="A silent notification keeps alerts coming with the app closed"
            lead={<Lead name="shield" />}
            checked={keepAlive}
            trail={<Switch on={keepAlive} />}
            onPress={() => toggleKeepAlive(!keepAlive)}
          />
        ) : null}
      </Group>
      {alerts?.ok && canKeepAlive ? (
        <View style={{ paddingHorizontal: SPACE.xs, paddingTop: SPACE.xs }}>
          {/* Said plainly rather than implied. Android 15 (API 35) cuts a
              background process's network a few seconds after the screen goes
              off, which is what silently dropped alerts that arrived while the
              phone was in a pocket — measured on the emulator, the live socket
              in src/lib/live.ts died 3-6s after HOME. The switch above is what
              keeps that connection open; without it, this is what happens.
              Only drawn next to the switch it names: on iOS, in Expo Go, or
              with alerts off there is no such switch, and this used to claim
              one anyway. */}
          <Note>
            Without "Stay connected in the background", Android cuts this connection a few seconds
            after you leave the app.
          </Note>
        </View>
      ) : null}

      <GroupTitle text="Appearance" />
      <Group inset={50}>
        <Row
          title="Theme"
          sub={look.mode === "system" ? `Following the phone, ${look.polarity} now` : undefined}
          lead={<Lead name="contrast" />}
          trail={<Pick label="Theme" value={look.mode} options={MODES} onChange={(mode) => setLook({ mode })} />}
        />
        <View>
          <Row
            title="Accent"
            sub="The cursor, the tab you are on, a button that does something"
            lead={<Lead name="type" />}
          />
          <Swatches />
        </View>
      </Group>

      <GroupTitle text="Terminal" />
      <Group inset={50}>
        <Row
          title="Width"
          /* 60 to read, 80 to work. There is no wider rung on purpose: measured
             on this screen, 120 columns clips each glyph inside its own cell
             and characters change identity — a seven loses its bar and reads as
             a slash, so a commit hash comes back wrong. And it is what the pane
             is RESIZED to while the phone looks at it, not a zoom on the glass:
             a wider pane is shown from its left edge, and the terminal says so. */
          sub="Columns asked of the pane while you look"
          lead={<Lead name="fit" />}
          trail={
            <Pick
              label="Width"
              value={String(cols)}
              options={COLUMNS.map((n) => ({ id: String(n), name: String(n) }))}
              onChange={(v) => { const n = Number(v); setTermColumns(n); setCols(n); }}
            />
          }
        />
        <Row
          title="Keyboard suggestions"
          /* Off by default because the field usually holds a command: a
             keyboard that helps rewrites flags, paths and branch names into
             English, silently, and the first you know is a command that did not
             run — or one that ran differently. */
          sub={assist ? "Autocorrect may rewrite what you compose" : "Off keeps commands exactly as typed"}
          lead={<Lead name="spark" />}
          checked={assist}
          trail={<Switch on={assist} />}
          onPress={() => { setTermAssist(!assist); setAssist(!assist); }}
        />
        <Row
          title="Key bar"
          sub={`${onBar} keys on the bar${keys.mine.length ? ` · ${keys.mine.length} of your own` : ""}`}
          lead={<KeyboardIcon color={C.text2} size={20} />}
          chevron
          onPress={() => router.push("/terminal-settings")}
        />
      </Group>

      <GroupTitle text="Help" />
      <Group inset={50}>
        <Row
          title="Troubleshooting"
          sub="What this computer has, and what is missing"
          lead={<Lead name="wrench" />}
          chevron
          onPress={() => router.push("/troubleshoot")}
        />
        <Row
          title="Version"
          lead={<Lead name="info" />}
          trail={
            <Text style={{ color: C.text3, fontSize: T.body, fontFamily: MONO }}>
              {Constants.expoConfig?.version ?? "unknown"}
            </Text>
          }
        />
      </Group>

      <View style={{ paddingTop: SPACE.lg }}>
        <Btn label="Forget this computer" tone="danger" busy={going} onPress={onForget} />
      </View>

      <ComputerSheet open={sheet} onClose={() => setSheet(false)} onForget={onForget} />
    </ScrollView>
  );
}
