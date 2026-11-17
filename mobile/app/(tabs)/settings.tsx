/*
 * Settings: the computer, and the preferences of this phone.
 *
 * ── what is here, and what left ──────────────────────────────────────────
 * Five groups — Computer, Notifications, Appearance, Terminal, Help — and
 * nothing that is not a setting. The plan is the chip on every header, the
 * queue is answered in the terminal, and Source control opens from the
 * terminal it belongs to.
 *
 * ── the shape ────────────────────────────────────────────────────────────
 * A row states the setting and, on its right, its value; the control that
 * changes it is behind the row, in a sheet. The exception is the switch, which
 * IS the value and would be a tap wasted to open a sheet for it. The app used
 * to draw every choice inline — three look cards, eight accent swatches, a
 * segmented width — so the page was longer than the screen and the answer to
 * "what is it set to" had to be found among the controls instead of read on
 * the row.
 *
 * The scope is not editable here and never will be: it was chosen at the
 * computer by somebody looking at the request, and a phone that could widen its
 * own grant would make that choice decorative. It is said, in the computer's
 * sheet, with what would change it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  Alert, AppState, Linking, Pressable, ScrollView, Text, View, useWindowDimensions,
} from "react-native";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import Constants from "expo-constants";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { since } from "../../src/lib/dates.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { useComputer } from "../../src/state/use-computer.ts";
import {
  alertsDeliverable, askForAlerts, blockedText, notificationsSupported, offersOpenSettings, raise, watchAlertsDeliverable,
  type Delivery,
} from "../../src/notifications/notify.ts";
import {
  keepAliveAvailable, keepAliveRunning, loadKeepAlivePref, saveKeepAlivePref, syncKeepAlive, wantKeepAlive,
} from "../../src/notifications/keepAlive.ts";
import { onTalkPref, setTalkPref, talkPref, type TalkPref } from "../../src/notifications/talkPref.ts";
import { readPhoneAlerts, setPhoneAlerts } from "../../src/notifications/phoneAlertsPref.ts";
import { onQuietPref, quietPref } from "../../src/notifications/quietPref.ts";
import { quietText, type QuietPref } from "../../src/model/quietHours.ts";
import { QuietHoursSheet } from "../../src/settings/QuietHoursSheet.tsx";
import { Btn, Eyebrow, Group, Note, Row, Sheet, Switch, TAP, useFlash } from "../../src/ui.tsx";
import { Glyph, type GlyphName } from "../../src/nav/glyphs.tsx";
import { KeyboardIcon } from "../../src/nav/icons.tsx";
import {
  ACCENTS, C, MONO, RADIUS, SPACE, T, currentLook, deskPreview, ink, setLook, tint, type Palette, type ThemeMode,
} from "../../src/theme.ts";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { trackersSummary } from "../../src/model/trackerRows.ts";
import { useProviders } from "../../src/state/use-tracks-work.ts";
import { phonePalette } from "../../../shared/palettes.ts";
import type { DeviceScope } from "../../../shared/types.ts";
import { ACCESSORY_KEYS } from "../../src/terminal/keys.ts";
import { rows as keyRows } from "../../src/terminal/keyLayout.ts";
import { bytesFor } from "../../src/terminal/customKeys.ts";
import {
  CURSORS, customKeys, keyLayout, onTermPrefs, setTermAssist, setTermColumns, setTermCursor, stepColumns, termAssist,
  termColumns, termCursor, textSizeFor, type CursorShape,
} from "../../src/terminal/termPrefs.ts";
import { density, onUiPrefs, reducesMotion, setUiPrefs, type Density } from "../../src/uiPrefs.ts";

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
    what: "The above, plus approving a gate waiting on you and replying to a running session.",
  },
  full: {
    // Was "Everything" on the sheet's own card, "Full access" on the chip
    // three inches away — one grant, described two ways on the same screen.
    name: "Full access",
    chip: "Full access",
    what: "The terminal, git write, Docker and merging. A grant for a laptop you trust.",
  },
};

/** A leading mark on the one row that is about a thing rather than a setting:
 *  the computer. The rest of the page is text, as the mock draws it. */
const Lead = ({ name }: { name: GlyphName }): React.ReactNode => (
  <View style={{
    width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center",
    backgroundColor: tint(C.primary, 0.14),
  }}>
    <Glyph name={name} color={C.primary} size={16} />
  </View>
);

/** The value at the end of a row: "Match the computer", "22:00 – 07:00". */
function Val({ text }: { text: string }): React.ReactNode {
  return <Text numberOfLines={1} style={{ color: C.text3, fontSize: 13 }}>{text}</Text>;
}

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
            style={({ pressed }) => ({
              minHeight: TAP, paddingHorizontal: SPACE.md, borderRadius: RADIUS.pill,
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
 * The accents, two rows of four.
 *
 * Eight across was 8 x 44 = 352 in a card that has 329 inside its padding on a
 * 393 dp screen and less on a 360 dp phone, so the last swatch wrapped onto a
 * line of its own. Four across at 48 is 192 and fits every phone, with the
 * leftover spread by the row.
 */
function Swatches(): React.ReactNode {
  const look = currentLook();
  const rows = [ACCENTS.slice(0, 4), ACCENTS.slice(4)];
  return (
    <View style={{ paddingHorizontal: SPACE.md, paddingBottom: SPACE.md, gap: SPACE.sm }}>
      {rows.map((row, r) => (
        <View key={r} style={{ flexDirection: "row", gap: SPACE.sm }}>
          {row.map((a) => {
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
                style={({ pressed }) => ({
                  flex: 1, height: TAP, borderRadius: RADIUS.lg, backgroundColor: face,
                  alignItems: "center", justifyContent: "center",
                  // Selected is a ring with the card showing through the gap,
                  // not a border in a colour: there is no colour that is
                  // visible against all eight faces, and the card is.
                  borderWidth: 2, borderColor: on ? C.text : "transparent",
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                {on ? <Glyph name="check" color={ink(face)} size={20} /> : null}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/** The three looks, as cards that show what they are: a thumbnail in the
 *  palette it would paint, then a name and one line. */
function LookCards(): React.ReactNode {
  const look = currentLook();
  const desk = deskPreview();
  const light = phonePalette("light", look.accent);
  const dark = phonePalette("dark", look.accent);
  const cards: { id: ThemeMode; name: string; sub: string; p: Palette }[] = [
    {
      id: "desk", name: "Match the computer",
      sub: desk ? "Follows the desk theme" : "Follows the desk theme; the phone\u2019s own until it answers",
      p: desk ?? phonePalette(look.polarity, look.accent),
    },
    { id: "light", name: "Light", sub: "Warm paper, always", p: light },
    { id: "dark", name: "Dark", sub: "Always dark", p: dark },
  ];
  return (
    <View style={{ paddingHorizontal: SPACE.md, paddingBottom: SPACE.md }}>
      <View accessibilityRole="radiogroup" accessibilityLabel="Look" style={{ flexDirection: "row", gap: SPACE.sm }}>
        {cards.map((c) => {
          const on = look.mode === c.id;
          return (
            <Pressable
              key={c.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => setLook({ mode: c.id })}
              style={({ pressed }) => ({
                flex: 1, padding: SPACE.sm, borderRadius: RADIUS.lg, gap: 6,
                borderWidth: 2, borderColor: on ? C.primary : C.border2,
                backgroundColor: on ? tint(C.primary, 0.1) : "transparent",
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <View style={{
                height: 52, borderRadius: RADIUS.sm, backgroundColor: c.p.bg, padding: 8, gap: 5,
                borderWidth: 1, borderColor: c.p.border2,
              }}>
                <View style={{ height: 5, width: "70%", borderRadius: 3, backgroundColor: c.p.text }} />
                <View style={{ height: 5, width: "40%", borderRadius: 3, backgroundColor: c.p.primary }} />
                <View style={{ height: 5, width: "85%", borderRadius: 3, backgroundColor: c.p.border2 }} />
              </View>
              <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>{c.name}</Text>
              <Text style={{ color: C.text3, fontSize: T.small }}>{c.sub}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** What "Look" answers on its row. */
const LOOK_WORD: Record<ThemeMode, string> = {
  desk: "Match the computer",
  light: "Light",
  dark: "Dark",
  system: "Match this phone",
};

/** The computer: what it is called, where it is, and what this phone may do
 *  to it. A sheet, because it is looked at and dismissed. */
function ComputerSheet({ open, onClose, onForget, going }: {
  open: boolean;
  onClose: () => void;
  onForget: () => void;
  going: boolean;
}): React.ReactNode {
  const { host, live, fleet } = useAgentglass();
  const computer = useComputer(host);
  const router = useRouter();
  const [copied, flash] = useFlash();
  // The confirmation lives in the sheet, where the button was pressed: a system
  // alert over a sheet is two layers asking one question.
  const [sure, setSure] = useState(false);
  useEffect(() => { if (!open) setSure(false); }, [open]);
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
          label={copied ? "Address copied" : "Copy the address"}
          onPress={() => {
            void Clipboard.setStringAsync(host.origin);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            flash();
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
        {sure ? (
          <View style={{ gap: SPACE.sm, padding: SPACE.md, borderRadius: RADIUS.lg, backgroundColor: tint(C.error, 0.12) }}>
            <Text style={{ color: C.error, fontSize: T.body, fontWeight: "600" }}>Forget this computer?</Text>
            {/* Said plainly, because it is the half people get wrong: this drops
                the phone's copy. The credential stays valid until it is revoked
                at the computer, and a phone cannot be trusted to revoke itself —
                a phone that has been taken is exactly the one that will not. */}
            <Note>
              This phone will lose its credential and you will pair again to come back. To cut it off
              for good, forget the device at the computer as well.
            </Note>
            <View style={{ flexDirection: "row", gap: SPACE.sm }}>
              <Btn label="Keep it" disabled={going} style={{ flex: 1 }} onPress={() => setSure(false)} />
              <Btn label="Forget" tone="danger" busy={going} style={{ flex: 1 }} onPress={onForget} />
            </View>
          </View>
        ) : (
          // Soft red with red words: the page used to end in a full-width red
          // button, which is a mis-tap waiting for a thumb on its way down.
          <Pressable
            accessibilityRole="button"
            onPress={() => setSure(true)}
            style={({ pressed }) => ({
              minHeight: TAP, alignItems: "center", justifyContent: "center", borderRadius: RADIUS.md,
              backgroundColor: tint(C.error, pressed ? 0.22 : 0.12),
            })}
          >
            <Text style={{ color: C.error, fontSize: T.body, fontWeight: "600" }}>Forget this computer…</Text>
          </Pressable>
        )}
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
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const [going, setGoing] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [lookSheet, setLookSheet] = useState(false);
  const [quietSheet, setQuietSheet] = useState(false);
  const look = currentLook();
  const providers = useProviders(host);

  /* Done in the header, as the mock draws it: this screen is pushed from the
     terminal or a header gear, and the way out is worth naming when the page is
     longer than the screen. */
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done"
          onPress={() => router.back()}
          style={({ pressed }) => ({
            minHeight: TAP, minWidth: TAP, paddingHorizontal: SPACE.md, alignItems: "center", justifyContent: "center",
            borderRadius: RADIUS.md, backgroundColor: pressed ? C.bg3 : "transparent",
          })}
        >
          <Text style={{ color: C.primary, fontSize: T.body, fontWeight: "600" }}>Done</Text>
        </Pressable>
      ),
    });
  }, [navigation, router]);

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

  /* Quiet hours and the two appearance choices, mirrored the same way: they
     are module singletons the socket and ui.tsx read, and this page is only
     one of their writers. */
  const [quiet, setQuiet] = useState<QuietPref>(quietPref);
  useEffect(() => onQuietPref(() => setQuiet(quietPref())), []);
  const [prefs, setPrefs] = useState(() => ({ density: density(), motion: !reducesMotion() }));
  useEffect(() => onUiPrefs(() => setPrefs({ density: density(), motion: !reducesMotion() })), []);

  /* "Alerts on this phone" is the computer's value (phoneAlertsPref.ts), so the
     desk shows the same switch. null until it answers: the row waits rather than
     drawing a guess. */
  const [phoneAlerts, setPhoneAlertsOn] = useState<boolean | null>(null);
  /* Whether a watch alert can be drawn: the permission and ITS channel, not the agent alerts channel. Asked again
     whenever the agent card's answer moves (a permission just granted shows here too). */
  const [watchOk, setWatchOk] = useState<Delivery | null>(null);
  useEffect(() => { void watchAlertsDeliverable().then(setWatchOk); }, [alerts]);
  useEffect(() => { setPhoneAlertsOn(null); }, [host]);
  /* Read again whenever this screen comes into view or the app returns to the front: the desk (or an agent)
     may have changed it since, and a switch that shows the old value is a switch that lies. */
  const readPhone = useCallback((): void => {
    if (host) void readPhoneAlerts(host).then((v) => { if (v !== null) setPhoneAlertsOn(v); });
  }, [host]);
  useFocusEffect(readPhone);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => { if (state === "active") readPhone(); });
    return () => sub.remove();
  }, [readPhone]);
  const mayChangePhone = host?.scope === "full";
  const flipPhoneAlerts = useCallback((on: boolean): void => {
    if (!host) return;
    setPhoneAlertsOn(on);
    void setPhoneAlerts(host, on).then((r) => {
      if (r.ok) return;
      setPhoneAlertsOn(!on);
      Alert.alert("That was not saved", r.error);
    });
  }, [host]);

  /* The terminal's preferences are module singletons shared with the pane;
     these are the local mirrors that make this screen repaint. */
  const [cols, setCols] = useState(termColumns);
  const [assist, setAssist] = useState(termAssist);
  const [cursor, setCursor] = useState<CursorShape>(termCursor);
  const [keys, setKeys] = useState(() => ({ layout: keyLayout(), mine: customKeys() }));
  useEffect(() => onTermPrefs(() => {
    setCols(termColumns()); setAssist(termAssist()); setCursor(termCursor()); setKeys({ layout: keyLayout(), mine: customKeys() });
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
    setGoing(true);
    // A refused forget leaves the phone paired; the button must come back.
    void forget().catch(() => setGoing(false));
  }, [forget]);

  if (!host) return null;

  const supported = notificationsSupported();
  const status = live === "open" ? "Connected" : live === "connecting" ? "Connecting…" : "Offline";
  const canType = host.scope === "answer" || host.scope === "full";
  // The bar under the size: the same place on it whatever the pane is asked
  // for. Concrete columns are the unit (see termPrefs.ts), and the size is
  // what those columns came out as on this phone.
  const size = textSizeFor(cols, width);
  const fill = Math.max(6, Math.min(100, Math.round(((size - 11.5) / (17 - 11.5)) * 100)));

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.xs, paddingBottom: SPACE.xl }}>
      <Eyebrow text="Computer" />
      <Group inset={50}>
        <Row
          title={computer}
          sub={`${status} · ${host.origin.replace(/^https?:\/\//, "")} · ${canType ? "this phone can type" : "this phone may look"}`}
          lead={<Lead name="computer" />}
          chevron
          onPress={() => setSheet(true)}
        />
      </Group>

      <Eyebrow text="Notifications" />
      <Group inset={50}>
        <Row
          title="Agent alerts"
          /* The reason, not a dead switch, when it cannot come on. Every one of
             these used to be drawn as either "off" or — worse, when the
             permission was granted and something else had failed — as ON. */
          sub={alerts === null ? "Checking…"
            : alerts.ok ? "When an agent waits, fails or stops"
            : blockedText(alerts.why)}
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
            // exists (see mapTalk in prs.ts).
            sub={alerts?.ok ? "This phone only, never for a bot" : "Needs agent alerts on first"}
            disabled={!alerts?.ok}
          />
          {/* Below the text, as the accent swatches are: three options beside
              a title this long truncated it to "Comments on you…". */}
          <View style={{ paddingLeft: SPACE.lg, paddingRight: SPACE.md, paddingBottom: SPACE.md, alignItems: "flex-start", opacity: alerts?.ok ? 1 : 0.45 }}>
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
        <Row
          title="Quiet hours"
          sub={quiet.on ? "Nothing rings; the Inbox still fills" : "Off: every alert rings, whatever the hour"}
          trail={<Val text={quietText(quiet)} />}
          chevron
          onPress={() => setQuietSheet(true)}
        />
        <Row
          title="Alerts on this phone"
          /* Which pull requests and cards: the ones the person armed or follows,
             nothing else. One switch for every phone paired to the computer, so
             a read-only phone says whose it is to change. */
          sub={!watchOk ? "Checking…"
            : !watchOk.ok ? blockedText(watchOk.why)
            : phoneAlerts === null ? "Checking…"
            : mayChangePhone ? "Your pull request watches and card comments. Same for every paired phone."
            : "Paired read-only: change it on the computer."}
          checked={watchOk?.ok === true && phoneAlerts === true}
          trail={<Switch on={watchOk?.ok === true && phoneAlerts === true} disabled={watchOk?.ok === true && (phoneAlerts === null || !mayChangePhone)} />}
          /* Waiting for an answer, or nothing to press: the OS prompt and Android's settings are the way out of a
             block, the same as the agent alerts row above; the switch itself is only live once an alert can be drawn. */
          disabled={asking || !watchOk || !notificationsSupported() || (watchOk.ok && (phoneAlerts === null || !mayChangePhone))}
          onPress={() => {
            if (!watchOk) return;
            if (watchOk.ok) flipPhoneAlerts(phoneAlerts !== true);
            else if (offersOpenSettings(watchOk.why)) void Linking.openSettings();
            else void turnOn();
          }}
        />
        {alerts && !alerts.ok && offersOpenSettings(alerts.why) ? (
          // Only when Android will no longer show its own prompt — a channel
          // switched off, or a permission refused once already. `not-asked`
          // is deliberately not this: the switch above still asks the OS
          // directly, and a button that jumps to Settings before anybody has
          // even been asked once is the bug this row used to have.
          <Row
            title="Open Android's settings"
            onPress={() => { void Linking.openSettings(); }}
          />
        ) : null}
        {alerts?.ok ? (
          <Row
            title="Send a test notification"
            onPress={() => {
              // Through the real path, with the app in the foreground — which
              // the policy would normally suppress, so this calls `raise`
              // directly. And it SAYS what happened: a button that silently does
              // nothing is the exact impression this feature cannot afford.
              void raise({ title: "agentglass", body: "This is what an alert looks like.", urgency: 1 })
                .then((d) => {
                  setAlerts(d);
                  if (!d.ok) Alert.alert("That alert was not shown", blockedText(d.why));
                });
            }}
          />
        ) : null}
        {alerts?.ok && canKeepAlive ? (
          <Row
            title="Stay connected in the background"
            sub="A silent notification keeps alerts coming with the app closed"
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

      <Eyebrow text="Appearance" />
      <Group inset={50}>
        <Row
          title="Look"
          sub="The app, not the pane: the terminal wears the desk's colours"
          trail={<Val text={LOOK_WORD[look.mode]} />}
          chevron
          onPress={() => setLookSheet(true)}
        />
        <Row
          title="Density"
          sub={prefs.density === "roomier" ? "Roomier: the one step above the 44 px floor" : "Default: the 44 px floor"}
          trail={
            <Pick<Density>
              label="Density"
              value={prefs.density}
              options={[{ id: "default", name: "Default" }, { id: "roomier", name: "Roomier" }]}
              onChange={(d) => setUiPrefs({ density: d })}
            />
          }
        />
        <Row
          title="Reduce motion"
          sub="No spring, no slide; the sheet just appears"
          checked={!prefs.motion}
          trail={<Switch on={!prefs.motion} />}
          onPress={() => setUiPrefs({ reduceMotion: prefs.motion })}
        />
      </Group>

      <Eyebrow text="Terminal" />
      <Group inset={SPACE.lg}>
        <View style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md, gap: SPACE.sm }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: SPACE.sm }}>
            <Text style={{ flex: 1, color: C.text, fontSize: 14.5, fontWeight: "600" }}>Text size</Text>
            <Text style={{ color: C.text3, fontSize: 13 }}>{cols} characters across</Text>
          </View>
          {/* What the choice looks like, in the pane's own face: a number of
              columns says nothing to somebody deciding whether their commit
              hash is readable. */}
          <View style={{
            backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.sm,
            paddingHorizontal: SPACE.sm, paddingVertical: 6,
          }}>
            <Text numberOfLines={1} style={{ color: C.text2, fontSize: 12, fontFamily: MONO }}>$ git status --short</Text>
            <Text numberOfLines={1} style={{ color: C.warning, fontSize: 12, fontFamily: MONO }}> M src/settings/rail.tsx</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
            <Btn
              label="A−"
              style={{ width: TAP, paddingHorizontal: 0 }}
              onPress={() => { const n = stepColumns(cols, width, -1); setTermColumns(n); setCols(n); }}
            />
            <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: C.bg3 }}>
              <View style={{ height: 6, borderRadius: 3, width: `${fill}%`, backgroundColor: C.primary }} />
            </View>
            <Btn
              label="A+"
              style={{ width: TAP, paddingHorizontal: 0 }}
              onPress={() => { const n = stepColumns(cols, width, 1); setTermColumns(n); setCols(n); }}
            />
          </View>
          <Note>
            56 to 120 columns. Above 120 a hash reads as the wrong characters on this phone.
          </Note>
        </View>
        <Row
          title="Cursor"
          sub="Takes effect the next time a pane opens"
          trail={(
            <Pick
              label="Cursor"
              value={cursor}
              options={CURSORS.map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }))}
              onChange={(v) => { setTermCursor(v); setCursor(v); }}
            />
          )}
        />
        <Row
          title="Key bar"
          sub={`${onBar} keys on the bar${keys.mine.length ? ` · ${keys.mine.length} of your own` : ""}`}
          lead={<KeyboardIcon color={C.text2} size={20} />}
          chevron
          onPress={() => router.push("/terminal-settings")}
        />
        <Row
          title="Keyboard suggestions"
          /* Off by default because the field usually holds a command: a
             keyboard that helps rewrites flags, paths and branch names into
             English, silently, and the first you know is a command that did not
             run — or one that ran differently. */
          sub={assist ? "Autocorrect may rewrite what you compose" : "Off keeps commands exactly as typed"}
          checked={assist}
          trail={<Switch on={assist} />}
          onPress={() => { setTermAssist(!assist); setAssist(!assist); }}
        />
      </Group>

      <Eyebrow text="Help" />
      <Group inset={50}>
        <Row
          title="Task sources"
          sub={trackersSummary(providers)}
          chevron
          onPress={() => router.push("/trackers")}
        />
        <Row
          title="Troubleshooting"
          sub="What this computer has, and what is missing"
          chevron
          onPress={() => router.push("/troubleshoot")}
        />
        <Row
          title="About"
          sub="agentglass for the phone"
          trail={
            <Text style={{ color: C.text3, fontSize: 13, fontFamily: MONO }}>
              {Constants.expoConfig?.version ?? "unknown"}
            </Text>
          }
        />
        <Row
          title="Open the dashboard"
          sub="This leaves the app for a browser"
          trail={<Btn label="Show it" onPress={() => { void Linking.openURL(host.origin); }} />}
        />
      </Group>

      <ComputerSheet open={sheet} onClose={() => setSheet(false)} onForget={onForget} going={going} />

      {/* Look: the three modes as cards that show what they paint, and the
          accent under them — the same question ("what does this phone wear"),
          so one sheet rather than two rows that both opened something. */}
      <Sheet open={lookSheet} onClose={() => setLookSheet(false)} title="Look" subtitle="Match the computer, or pin it to this phone">
        <LookCards />
        <View style={{ paddingHorizontal: SPACE.md, paddingBottom: SPACE.xs }}>
          <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>Accent</Text>
          <Text style={{ color: C.text3, fontSize: T.small, paddingTop: 2 }}>
            The cursor, the tab you are on, a button that does something.
          </Text>
        </View>
        <Swatches />
      </Sheet>

      <QuietHoursSheet open={quietSheet} onClose={() => setQuietSheet(false)} />
    </ScrollView>
  );
}
