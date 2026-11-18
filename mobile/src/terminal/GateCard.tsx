/*
 * A gate waiting on you, answered where it is read.
 *
 * It lived on the Now screen, a destination of its own, and the terminal only
 * said HOW MANY were held — a red band that sent you there. So answering an
 * agent meant leaving the agent. The card is drawn in the terminal now, over
 * the pane, and on the Terminal screen of a phone that may answer but not type.
 *
 * Painted from the palette it is handed rather than from `C`, because inside
 * the terminal that is the desk's palette and not the phone's — see the note on
 * one surface in app/(tabs)/terminal.tsx.
 *
 * Deny sits left of Allow and is drawn quieter, not the other way round: the
 * thumb lands on the right, and the loud button is the one somebody has just
 * read the command for.
 *
 * Allow HOLDS. Every allow, whatever the command says — the phone does not
 * carry a word list that decides which commands are dangerous, and the server
 * already treats the release as the dangerous half. Deny stays one tap: the
 * safe direction must not be slow. See model/confirmPolicy.ts.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import type { PendingGate } from "../../../shared/types.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { gateAsk, gateDetail, gateWhere, waited } from "../model/gates.ts";
import { MONO, RADIUS, SPACE, T, tint, type Palette } from "../theme.ts";
import { HoldButton, TAP } from "../ui.tsx";

/** A clock that moves once a minute — the grain of `waited`, and the same
 *  cadence the usage chip uses so a gate waiting on you does not re-render every second. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function GateCard({ gate, host, colors, onDone, onOpen }: {
  gate: PendingGate;
  host: Host;
  colors: Palette;
  /** Called once the machine has taken the answer, so the list is re-read. */
  onDone: () => void;
  /** Show the window it is in. Absent when that is the window on screen, or
   *  when this phone cannot open one. */
  onOpen?: () => void;
}): React.ReactNode {
  const K = colors;
  const now = useMinute();
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** A hold let go too early: said under the buttons, because a fill that
   *  vanished with no words reads as a button that did not work. */
  const [cancelled, setCancelled] = useState<string | null>(null);

  const decide = async (decision: "allow" | "deny"): Promise<void> => {
    setBusy(decision);
    setFailed(null);
    setCancelled(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const answer = await ask<{ ok: boolean; error?: string }>(host, "/gate/decide", {
      method: "POST",
      body: { id: gate.id, decision },
    });
    setBusy(null);
    if (!answer.ok) { setFailed(answer.error); return; }
    if (!answer.value.ok) {
      // Somebody at the desk, or the timeout, got there first. Said, because a
      // button that silently does nothing reads as a button that is broken.
      setFailed(answer.value.error || "Something already answered this one.");
      return;
    }
    onDone();
  };

  /** Deny only. The loud button is the hold, which is its own component. */
  const deny = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Deny: ${gateDetail(gate)}`}
      accessibilityState={{ disabled: busy !== null, busy: busy === "deny" }}
      disabled={busy !== null}
      onPress={() => { void decide("deny"); }}
      style={({ pressed }) => ({
        minHeight: TAP, minWidth: 88, paddingHorizontal: SPACE.lg, borderRadius: RADIUS.pill,
        alignItems: "center", justifyContent: "center",
        backgroundColor: "transparent",
        borderWidth: 1, borderColor: K.border2,
        opacity: busy !== null && busy !== "deny" ? 0.45 : 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      {busy === "deny"
        ? <ActivityIndicator color={K.text} />
        : <Text style={{ color: K.text, fontSize: T.body, fontWeight: "600" }}>Deny</Text>}
    </Pressable>
  );

  return (
    <View
      accessibilityRole="alert"
      style={{
        padding: SPACE.md, gap: SPACE.sm, borderRadius: RADIUS.lg,
        backgroundColor: K.bg3, borderWidth: 1, borderColor: tint(K.warning, 0.4),
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: K.warning }} />
        <Text style={{ color: K.warning, fontSize: T.small, fontWeight: "600" }}>Waiting on you</Text>
        <Text numberOfLines={1} style={{ color: K.text3, fontSize: T.small, flexShrink: 1 }}>
          · {gateWhere(gate)}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={{ color: K.text3, fontSize: T.small }}>{waited(gate.created, now)}</Text>
      </View>
      <Text style={{ color: K.text, fontSize: T.body, fontWeight: "500" }}>{gateAsk(gate)}</Text>
      <View style={{
        backgroundColor: K.bg, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.sm,
        borderWidth: 1, borderColor: K.border,
      }}>
        {/* Six lines and no more: a heredoc in a Bash call can be a page long,
            and the buttons under it are what the card is for. */}
        <Text selectable numberOfLines={6} style={{ color: K.text, fontFamily: MONO, fontSize: T.small }}>
          {gateDetail(gate)}
        </Text>
      </View>
      {failed ? <Text style={{ color: K.error, fontSize: T.small }}>{failed}</Text> : null}
      {cancelled ? <Text style={{ color: K.text3, fontSize: T.small }}>{cancelled}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
        {onOpen ? (
          <Pressable
            accessibilityRole="button"
            onPress={onOpen}
            style={({ pressed }) => ({
              minHeight: TAP, paddingHorizontal: SPACE.sm, justifyContent: "center",
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            <Text style={{ color: K.primary, fontSize: T.body, fontWeight: "600" }}>Open window</Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        {deny}
        <HoldButton
          action="gate.allow"
          label="Hold to allow"
          spoken={gateDetail(gate)}
          colors={K}
          disabled={busy !== null}
          onRelease={(said) => setCancelled(said)}
          onConfirm={() => { void decide("allow"); }}
        />
      </View>
    </View>
  );
}
