/*
 * Adding this phone to a computer.
 *
 * Four steps, and the order is the point: the QR is an invitation, not a key.
 * Scanning it gets you a form asking for six digits that are deliberately NOT
 * in the picture, and even then nothing exists until somebody at the computer
 * says yes. A photograph of that screen, a screenshot in a chat or a shared
 * window in a call is worth nothing — which is exactly what it was not, before
 * `server/src/pairing.ts` was rewritten.
 *
 * The camera step is the one this app adds. Here the camera is a permission,
 * not a protocol.
 *
 * ── what the QR actually opens ────────────────────────────────────────────
 * The cockpit — terminal, git write, docker — and not a read-mostly companion:
 * that page was deleted in 86b07f7, which says so itself ("it is a change in
 * what a QR opens"). This screen and `src/lib/pairing.ts` are the two files
 * somebody edits when they change what pairing grants, so they are the two
 * that have to be right about what is on the other side of the link.
 *
 * A browser opening that link over plain HTTP cannot pair at all, and that is
 * the whole reason there is a native app. `crypto.subtle` exists only in a
 * SECURE CONTEXT — HTTPS or localhost — so a page served from
 * `http://192.168.1.20:4000` cannot generate the ECDH key the handshake starts
 * with. @noble is plain JavaScript and needs no such thing, which is why the
 * LAN address pairs this app and no browser. The camera is gated the same way,
 * so a page on that address has neither half.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  fmtLeft, leftOnTicket, normalizeOrigin, makeKeys, readPairingCode, unseal, type PairKeys,
} from "../src/lib/pairing.ts";
import { probe } from "../src/lib/api.ts";
import { randomnessReady } from "../src/lib/rng.ts";
import type { Host } from "../src/lib/host.ts";
import { useAgentglass } from "../src/state/host-context.tsx";
import { Btn, Card, Field, Label, Note, TAP } from "../src/ui.tsx";
import { C, RADIUS, SPACE, T } from "../src/theme.ts";
import type { DeviceScope } from "../../shared/types.ts";

type Step = "start" | "scan" | "code" | "waiting";

/** How long to keep asking whether somebody accepted, when the computer has not
 *  said when the invitation dies. Slightly over the two-minute TTL, so a ticket
 *  minted the instant before the claim is followed to its actual end. */
const WAIT_MS = 130_000;
const POLL_MS = 1_500;

/** Under this, the countdown turns amber. Thirty seconds is about the point
 *  where the answer changes from "walk to the computer" to "show a new code",
 *  and that change should be visible without reading the number. */
const LOW_MS = 30_000;

/**
 * What the two minutes were spent on, said as a next step rather than as blame.
 *
 * This screen used to answer an expiry with "Nobody answered at the computer,
 * and the invitation has expired" — a sentence about a person, for the case
 * that is almost always about a clock. He is usually the person at both ends.
 */
const EXPIRED = "That invitation has run out. Show a new one on the computer — two minutes covers the whole trip, from the code appearing to somebody accepting it.";

/** What the computer says about the invitation: when it dies, on this phone's
 *  clock, or that it has never heard of it. `null` until we have asked. */
type Clock = { at: number } | "gone" | null;

export default function PairScreen(): React.ReactNode {
  const insets = useSafeAreaInsets();
  const { pair } = useAgentglass();

  const [step, setStep] = useState<Step>("start");
  const [origin, setOrigin] = useState("");
  const [ticket, setTicket] = useState("");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("My phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState<Clock>(null);
  const [now, setNow] = useState(() => Date.now());
  const [permission, requestPermission] = useCameraPermissions();

  // The keypair belongs to one attempt. Regenerating it between the claim and
  // the collect would leave a credential nothing on this phone can open.
  const keys = useRef<PairKeys | null>(null);
  const secret = useRef<string>("");
  const stop = useRef(false);
  const digits = useRef<TextInput>(null);
  /** Set when the ticket arrived ready-made and the form is about to appear,
   *  so the effect below knows to open the keypad on the one field left. */
  const wantDigits = useRef(false);

  useEffect(() => () => { stop.current = true; }, []);

  const fail = useCallback((message: string): void => {
    setError(message);
    setBusy(false);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  }, []);

  /**
   * A ticket has arrived whole — from the camera, from the clipboard, or pasted
   * into a field. Everything but the six digits is now filled in, so the six
   * digits are what gets the keyboard.
   *
   * The focus is split by step because a mounted field and one that is about to
   * mount need different treatment: pasting into the form focuses now, arriving
   * at the form focuses after the render that creates it.
   */
  const arrived = useCallback((read: { ticket: string; origin?: string }): void => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTicket(read.ticket);
    if (read.origin) setOrigin(read.origin);
    setError(null);
    if (step === "code") digits.current?.focus();
    else { wantDigits.current = true; setStep("code"); }
  }, [step]);

  useEffect(() => {
    if (step !== "code" || !wantDigits.current) return;
    wantDigits.current = false;
    // After the field exists, not with it: focusing in the same commit that
    // mounts a TextInput is a no-op on Android.
    const t = setTimeout(() => digits.current?.focus(), 250);
    return () => clearTimeout(t);
  }, [step]);

  /** The camera found something. It may well not be ours — a phone's camera
   *  points at whatever is in front of it. */
  const onScan = useCallback(({ data }: { data: string }): void => {
    if (step !== "scan") return;
    const read = readPairingCode(data);
    if (!read) return; // keep scanning rather than complaining at a wifi code
    arrived(read);
  }, [step, arrived]);

  /**
   * One tap for what is on the clipboard.
   *
   * Three shapes are worth accepting because all three are things the computer
   * offers: the pairing link behind the QR (address *and* ticket), the plain
   * address the Remote pane has a copy button for, and a bare ticket id read
   * out over the phone. Guessing between them is this function's whole job —
   * ticket first, because a twelve-character word in a pairing screen is a
   * ticket and not a hostname.
   */
  const paste = useCallback(async (): Promise<void> => {
    const text = (await Clipboard.getStringAsync().catch(() => "")).trim();
    const read = readPairingCode(text);
    if (read) { arrived(read); return; }
    // Not called `where`: pair-origin.test.ts holds every `const where` to the
    // address *field*, and this is a guess at what the clipboard was carrying.
    const asAddress = normalizeOrigin(text);
    if (asAddress) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setOrigin(asAddress);
      setError(null);
      setStep("code");
      return;
    }
    fail(text
      ? "What is on the clipboard is not a pairing link, an address or a ticket."
      : "There is nothing on the clipboard.");
  }, [arrived, fail]);

  /**
   * A field that takes the whole link, not just its last twelve characters.
   *
   * Both fields go through here: the address is the box people paste the link
   * into by mistake, and refusing it there would be a second way to lose the
   * two minutes. Everything that is not a link is left exactly as typed —
   * `readPairingCode` rejects a half-typed ticket, and a field that swallowed
   * the first five characters of one would be unusable by hand.
   */
  const absorb = useCallback((text: string): boolean => {
    const read = readPairingCode(text);
    if (!read?.origin) return false;
    arrived(read);
    return true;
  }, [arrived]);

  const openCamera = useCallback(async (): Promise<void> => {
    if (!permission?.granted) {
      const asked = await requestPermission();
      if (!asked.granted) {
        fail("Without the camera you can still type the address and the ticket by hand.");
        return;
      }
    }
    setError(null);
    setStep("scan");
  }, [permission, requestPermission, fail]);

  /*
   * Ask the computer how long this invitation has left.
   *
   * `/pair/info` takes no credential — it cannot, it is the step before there
   * is one — and answers with the ticket's own deadline. Without it the form
   * happily takes an address, twelve characters and six digits and only then
   * says the thing expired ninety seconds ago, which is one of the two ways he
   * lost this race today.
   *
   * Only asked once the ticket is a whole one. The server mints ids as
   * base64url of nine bytes, so every real one is twelve characters; anything
   * shorter is a field being typed into, and telling somebody their invitation
   * is unknown while they are halfway through writing it is noise, not news.
   */
  useEffect(() => {
    if (step !== "code") return;
    const id = ticket.trim();
    const where = normalizeOrigin(origin);
    if (!where || id.length < 12) { setClock(null); return; }

    let cancelled = false;
    // A deadline of its own, the same 4s `probe` uses. React Native's fetch has
    // none, and a mistyped address would otherwise leave one socket hanging per
    // pause in the typing.
    const stopAsking = new AbortController();
    // Debounced: this effect re-runs on every keystroke in either field.
    const timer = setTimeout(() => {
      const deadline = setTimeout(() => stopAsking.abort(), 4_000);
      void (async () => {
        try {
          const response = await fetch(
            `${where}/pair/info?ticket=${encodeURIComponent(id)}`,
            { signal: stopAsking.signal },
          );
          const info = (await response.json()) as { ok?: boolean; expiresAt?: number | null };
          if (cancelled) return;
          setClock(typeof info.expiresAt === "number"
            ? { at: Date.now() + leftOnTicket(info.expiresAt, response.headers.get("date")) }
            : "gone");
        } catch {
          // A wrong address or a phone off the wifi. `submit` is where that
          // gets named — a countdown is the wrong place to report a network.
          if (!cancelled) setClock(null);
        } finally {
          clearTimeout(deadline);
        }
      })();
    }, 400);

    return () => { cancelled = true; clearTimeout(timer); stopAsking.abort(); };
  }, [step, origin, ticket]);

  // One tick a second, and only while something on screen is counting.
  useEffect(() => {
    if (!clock || clock === "gone" || step === "start" || step === "scan") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [clock, step]);

  const left = clock && clock !== "gone" ? Math.max(0, clock.at - now) : null;
  const expired = clock === "gone" || left === 0;

  /** Claim, then wait for a person. */
  const submit = useCallback(async (): Promise<void> => {
    setError(null);

    const where = normalizeOrigin(origin);
    if (!where) { fail("That does not look like an address. Try 192.168.1.20:4000"); return; }
    /*
     * The normalised address goes back into the field, and this is not cosmetic.
     *
     * It used to be normalised HERE and nowhere else: the wait below read the
     * raw state, so a phone that paired by typing `192.168.1.20:4000` — which
     * is what the placeholder shows — stored an origin with no scheme. Every
     * fetch after that was schemeless, and the first WebSocket died on
     * `java.net.URL`'s "no protocol:", a red screen with a Java stack trace on
     * it and nothing about an address in sight. Found by pairing an emulator
     * the way the form tells you to.
     *
     * Writing it back also shows what the app will actually use, which is the
     * honest thing for a field that quietly rewrites what you typed.
     */
    if (where !== origin) setOrigin(where);
    if (!/^\d{6}$/.test(code.trim())) { fail("The code is the six digits on the computer's screen."); return; }
    if (!randomnessReady()) {
      // Said before anything is sent, not after: a key that cannot be
      // generated is not a thing to discover once somebody has typed a code.
      fail("This phone did not give the app a secure random source, so it cannot make a key.");
      return;
    }

    setBusy(true);

    const who = await probe(where);
    if (who === "down") { fail(`Nothing answered at ${where}. Same wifi as the computer?`); return; }
    if (who === "foreign") {
      // A 200 is not proof of identity — :4000 is a popular default, and a
      // stranger answering it makes every screen look empty rather than
      // misdirected.
      fail(`Something is running at ${where}, but it is not agentglass.`);
      return;
    }

    keys.current = makeKeys();
    let claimed: { ok: boolean; secret?: string; error?: string };
    try {
      const response = await fetch(`${where}/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticket: ticket.trim(),
          code: code.trim(),
          label: label.trim() || "A phone",
          pub: keys.current.pub,
        }),
      });
      claimed = (await response.json()) as typeof claimed;
    } catch {
      fail(`Could not reach ${where}.`);
      return;
    }

    if (!claimed.ok || !claimed.secret) {
      // The server writes these: how many tries are left, that the invitation
      // expired, that another device took it. They are better than anything
      // this screen could say, so they are shown as they arrive.
      fail(claimed.error || "That did not work.");
      setCode("");
      return;
    }

    secret.current = claimed.secret;
    setOrigin(where);
    setBusy(false);
    setStep("waiting");
  }, [origin, code, ticket, label, fail]);

  /*
   * The sixth digit is the end of the form, so it is the end of the typing too.
   *
   * Android draws no Go key on a `number-pad`, so finishing used to mean:
   * dismiss the keyboard, find the button it was covering, tap it. Two gestures
   * spent on a form that already knew it was complete.
   *
   * The deps are the digits alone, and deliberately: everything read in here
   * comes from the render in which `code` changed, so nothing is stale, and
   * re-firing on an address edit would spend a second attempt on a code that
   * had already been sent. The cost accepted is that a mistyped code costs one
   * of the five tries rather than being corrected in place — it was going to be
   * submitted by hand anyway, and the six digits are the biggest thing on the
   * screen.
   */
  useEffect(() => {
    if (step !== "code" || busy) return;
    if (!/^\d{6}$/.test(code)) return;
    // Never into an incomplete form: a claim needs an address and a ticket, and
    // firing without them would answer a finished code with a complaint about
    // a field somewhere above it.
    if (!normalizeOrigin(origin) || ticket.trim().length < 6) return;
    void submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Waiting on a person walking to a computer. Polled, because that is what
  // the server offers and because a socket for one 90-second wait is not worth
  // the reconnect logic.
  useEffect(() => {
    if (step !== "waiting") return;
    // Normalised again rather than trusted. `setOrigin` above is a state update
    // and this effect can run on the render that scheduled it, so the raw value
    // is still reachable here for exactly one pass — which is all it took.
    const where = normalizeOrigin(origin) ?? origin;
    const id = ticket.trim();
    const started = Date.now();
    // The invitation's own deadline when the computer gave us one. The fallback
    // is a span, and it is longer than the TTL on purpose: a ticket claimed the
    // second it was minted has the full two minutes left to be accepted in.
    const until = clock && clock !== "gone" ? clock.at : started + WAIT_MS;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      if (Date.now() > until) {
        setStep("code");
        fail(EXPIRED);
        return;
      }
      try {
        const response = await fetch(
          `${where}/pair/collect?ticket=${encodeURIComponent(id)}&secret=${encodeURIComponent(secret.current)}`,
        );
        const answer = (await response.json()) as {
          state: string;
          wrapped?: { pub: string; iv: string; data: string };
          scope?: DeviceScope;
          label?: string;
        };

        if (answer.state === "accepted" && answer.wrapped && keys.current) {
          const token = unseal(answer.wrapped, keys.current.priv, id);
          const host: Host = {
            origin: where,
            token,
            label: answer.label || label.trim() || "A phone",
            scope: answer.scope ?? "answer",
            pairedAt: Date.now(),
          };
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          await pair(host);
          return; // the root layout takes it from here
        }
        if (answer.state === "rejected") {
          setStep("code");
          fail("That request was turned down at the computer.");
          return;
        }
        if (answer.state === "unknown") {
          // Past the claim there is only one way to get here: the ticket was
          // swept. The secret matched a moment ago and nothing revokes it.
          setStep("code");
          fail(EXPIRED);
          return;
        }
      } catch {
        // A dropped poll is not a failure — the phone is on a phone network.
      }
      if (!cancelled) timer = setTimeout(() => { void tick(); }, POLL_MS);
    };

    let timer = setTimeout(() => { void tick(); }, POLL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [step, origin, ticket, label, pair, fail, clock]);

  const pad = { paddingTop: insets.top + SPACE.lg, paddingBottom: insets.bottom + SPACE.xl };

  if (step === "scan") {
    return (
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={onScan}
        />
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: SPACE.lg, ...pad, gap: SPACE.md }}>
          <Text style={{ color: "#fff", fontSize: T.body, textAlign: "center" }}>
            Point it at the code in Settings ▸ Remote access
          </Text>
          <Btn label="Type it instead" onPress={() => setStep("code")} />
        </View>
      </View>
    );
  }

  return (
    /*
     * `padding` on Android too, and no offset — this screen is declared
     * `headerShown: false` in app/_layout.tsx, so it starts at the top of the
     * display and RN's `frame.y + frame.height` is already in screen
     * coordinates. See app/(tabs)/terminal.tsx for the arithmetic.
     *
     * It shipped `behavior={undefined}` on Android, which does nothing at all,
     * and the cost was not cosmetic: the six digits sat under the keyboard, a
     * tap meant to reach them landed on the keys instead, focus stayed on the
     * address field, and the code was typed into the address —
     * `127.0.0.1:4010724237`, measured by hand. Every miss burns a whole
     * ticket, because a ticket lives 120 seconds; this is the likeliest
     * explanation for "three attempts and two expiries" pairing from outside.
     *
     * Once the scroller ends above the keyboard rather than behind it, Android
     * brings the focused field into view by itself — android.widget.ScrollView
     * scrolls to a newly focused child, which is why there is no scrollTo call
     * here. It could not do it before because as far as it knew nothing was
     * covered.
     */
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: C.bg }}
      behavior="padding"
    >
      <ScrollView
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg, ...pad }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: SPACE.xs }}>
          <Text style={{ color: C.text, fontSize: T.head, fontWeight: "700" }}>Add this phone</Text>
          <Note>
            On the computer, open agentglass ▸ Settings ▸ Remote access. It shows a code and six
            digits.
          </Note>
        </View>

        {step === "start" ? (
          <Card>
            <Btn label="Scan the code" tone="primary" onPress={() => { void openCamera(); }} />
            {/* Second, above typing: a link that reached this phone in a
                message is a whole pairing minus six digits, and the alternative
                is a long-press, a menu and twelve characters of proofreading. */}
            <Btn label="Paste a link" onPress={() => { void paste(); }} />
            <Btn label="Type it by hand" onPress={() => setStep("code")} />
            {error ? <Note tone="bad">{error}</Note> : null}
          </Card>
        ) : null}

        {step === "code" ? (
          <Card>
            <Field
              label="The computer's address"
              value={origin}
              onChangeText={(text) => { if (!absorb(text)) setOrigin(text); }}
              placeholder="192.168.1.20:4000"
              kind="code"
            />
            {/* The label and the placeholder both say "link", because the field
                accepting one is the entire fix and nothing else on the screen
                could tell him. It used to read "from the QR code", which is
                where the ticket comes from and not what may be put in here. */}
            <Field
              label="Ticket, or the whole link"
              value={ticket}
              onChangeText={(text) => { if (!absorb(text)) setTicket(text); }}
              placeholder="paste http://…/?pair=… here"
              kind="code"
            />
            <Btn label="Paste a link" onPress={() => { void paste(); }} />
            <Countdown left={left} expired={expired} known={clock !== null} />
            <Field
              ref={digits}
              label="The six digits"
              value={code}
              onChangeText={(text) => setCode(text.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              kind="digits"
              style={{ fontSize: 24, letterSpacing: 6, textAlign: "center" }}
              onSubmitEditing={() => { void submit(); }}
            />
            {error ? <Note tone="bad">{error}</Note> : null}
            <Btn label="Ask to be added" tone="primary" busy={busy} onPress={() => { void submit(); }} />
            {/* Below the button on purpose. It arrives filled in and nothing
                fails without it, so it is not one of the things between him and
                being added — and every field above the button reads like one. */}
            <Field label="Call this phone" value={label} onChangeText={setLabel} placeholder="My phone" />
            <Btn label="Scan instead" onPress={() => { void openCamera(); }} />
          </Card>
        ) : null}

        {step === "waiting" ? (
          <Card>
            <Label text="Waiting" />
            <Text style={{ color: C.text, fontSize: T.title }}>
              Go and accept it on the computer.
            </Text>
            <Note>
              The request is in Settings ▸ Remote access, naming this phone and the same six digits.
              Nothing is created until somebody agrees.
            </Note>
            <View style={{
              height: TAP, borderRadius: RADIUS.md, backgroundColor: C.bg3,
              alignItems: "center", justifyContent: "center",
            }}>
              <Text style={{ color: C.text3, fontSize: T.small }}>{code}</Text>
            </View>
            {/* The same clock, on the screen where it is actually running out:
                this is the minute somebody has to walk to the computer, and it
                is the half of the two minutes he was losing blind. */}
            <Countdown left={left} expired={expired} known={clock !== null}
              tail="left to accept it at the computer." />
            <Btn label="Cancel" onPress={() => { setStep("code"); setError(null); }} />
          </Card>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * The two minutes, on the phone rather than only on the computer.
 *
 * Nothing here used to say the invitation was running out; it simply stopped
 * working, and the form went on accepting an address, twelve characters and six
 * digits into a ticket that had died a minute earlier. Three attempts and two
 * expiries, watched, the first time somebody paired from outside the flat.
 *
 * Silent until the computer has answered, because a countdown the phone made up
 * is worse than none: it would read as fact and be a guess about a clock this
 * phone does not own.
 */
function Countdown({ left, expired, known, tail = "left — that includes somebody accepting it at the computer." }: {
  left: number | null;
  expired: boolean;
  known: boolean;
  tail?: string;
}): React.ReactNode {
  if (!known) return null;
  return (
    <Text style={{
      color: expired ? C.error : (left ?? 0) <= LOW_MS ? C.warning : C.text3,
      fontSize: T.body,
      lineHeight: 20,
    }}>
      {expired ? EXPIRED : `${fmtLeft(left ?? 0)} ${tail}`}
    </Text>
  );
}
