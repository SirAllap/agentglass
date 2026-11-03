/*
 * "An agent asks to change a setting", answered from the phone.
 *
 * The companion exists for the person who is away: an agent is stopped on a
 * settings request, and the only hand that could answer it was the desk's. The
 * card is the answer — the server's label, the server's diff, Approve and
 * Decline — and the phone's paired credential does the deciding (the server's
 * `mayAnswerSettingsRequest` admits a device with the `answer` grant and
 * nothing weaker).
 *
 * Every word on the card is the server's. The agent asked for a VALUE; the
 * diff is what the server computed from the value it validated, and it is
 * drawn as data in a mono block. Nothing here reads a line of it as an
 * instruction.
 *
 * Painted from the palette it is handed rather than from `C`, because inside
 * the terminal that is the desk's palette — the same rule GateCard follows.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import { askHeadline, isPolarisSend, type SettingRequestView } from "../../../shared/settingClass.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { decideBody, requestLines, requestsInOrder, requestTitle } from "../model/settingsRequests.ts";
import { MONO, RADIUS, SPACE, T, ink, tint, type Palette } from "../theme.ts";
import { TAP } from "../ui.tsx";

/** The pending requests, read from the computer and kept in step with the
 *  fleet's own tick so a request raised elsewhere shows up here too. */
export function SettingsRequestList({ host, colors, tick, onDone, style }: {
  host: Host;
  colors: Palette;
  /** Padding for the screen it is drawn on: the card itself carries none. */
  style?: StyleProp<ViewStyle>;
  /** The fleet's last successful load, so this re-reads on the same clock the
   *  gates do rather than on a poll of its own. */
  tick: number;
  /** Called once the machine has taken an answer, so the lists are re-read. */
  onDone: () => void;
}): React.ReactNode {
  const K = colors;
  const [list, setList] = useState<SettingRequestView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void ask<{ ok: boolean; requests: SettingRequestView[] }>(host, "/settings/requests").then((a) => {
      if (!alive) return;
      if (!a.ok) { setError(a.error); return; }
      setError(null);
      // Guarded like the gates' list: a type annotation is a claim about the
      // server, and one `undefined` here takes the screen down.
      setList(Array.isArray(a.value.requests) ? a.value.requests : []);
    });
    return () => { alive = false; };
  }, [host, tick]);

  const requests = requestsInOrder(list);
  if (!requests.length && !error) return null;
  return (
    <View style={[{ gap: SPACE.sm }, style]}>
      {requests.length ? (
        <Text style={{ color: K.text2, fontSize: T.body, fontWeight: "600" }}>
          {requests.length === 1 ? "A request waits for you" : `Requests waiting for you · ${requests.length}`}
        </Text>
      ) : null}
      {error ? <Text style={{ color: K.error, fontSize: T.small }}>{error}</Text> : null}
      {requests.map((r) => (
        <SettingsRequestCard
          key={r.id}
          request={r}
          host={host}
          colors={colors}
          onDone={() => { setList((prev) => prev.filter((x) => x.id !== r.id)); onDone(); }}
        />
      ))}
    </View>
  );
}

function SettingsRequestCard({ request, host, colors, onDone }: {
  request: SettingRequestView;
  host: Host;
  colors: Palette;
  onDone: () => void;
}): React.ReactNode {
  const K = colors;
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const title = requestTitle(request);

  const answer = async (approve: boolean): Promise<void> => {
    setBusy(approve ? "approve" : "decline");
    setFailed(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const taken = await ask<{ ok: boolean; error?: string }>(host, "/settings/requests/decide", {
      method: "POST",
      body: decideBody(request, approve),
    });
    setBusy(null);
    if (!taken.ok) { setFailed(taken.error); return; }
    if (!taken.value.ok) {
      // Somebody at the desk, or the request's own expiry, got there first.
      // Said, because a button that silently does nothing reads as broken.
      setFailed(taken.value.error || "That request is no longer waiting.");
      return;
    }
    onDone();
  };

  const button = (label: string, approve: boolean): React.ReactNode => {
    const loud = approve;
    const face = loud ? K.primary : "transparent";
    const which = approve ? "approve" : "decline";
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${title}`}
        accessibilityState={{ disabled: busy !== null, busy: busy === which }}
        disabled={busy !== null}
        onPress={() => { void answer(approve); }}
        style={({ pressed }) => ({
          minHeight: TAP, minWidth: 88, paddingHorizontal: SPACE.lg, borderRadius: RADIUS.pill,
          alignItems: "center", justifyContent: "center",
          backgroundColor: face,
          borderWidth: loud ? 0 : 1, borderColor: K.border2,
          opacity: busy !== null && busy !== which ? 0.45 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        })}
      >
        {busy === which
          ? <ActivityIndicator color={loud ? ink(face) : K.text} />
          : <Text style={{ color: loud ? ink(face) : K.text, fontSize: T.body, fontWeight: "600" }}>{label}</Text>}
      </Pressable>
    );
  };

  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={`${askHeadline(request)}: ${title}`}
      style={{
        padding: SPACE.md, gap: SPACE.sm, borderRadius: RADIUS.lg,
        backgroundColor: K.bg3, borderWidth: 1, borderColor: tint(K.primary, 0.35),
      }}
    >
      <Text style={{ color: K.text, fontSize: T.body, fontWeight: "600" }}>{askHeadline(request)}</Text>
      <Text style={{ color: K.text2, fontSize: T.small }}>{title}</Text>
      <View style={{
        backgroundColor: K.bg, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.sm,
        borderWidth: 1, borderColor: K.border,
      }}>
        {/* The server's diff, as data. Twelve lines: a request longer than that
            is one to answer at the desk, and the buttons stay reachable. */}
        <Text selectable numberOfLines={12} style={{ color: K.text, fontFamily: MONO, fontSize: T.small }}>
          {requestLines(request).join("\n")}
        </Text>
      </View>
      {failed ? <Text style={{ color: K.error, fontSize: T.small }}>{failed}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
        <View style={{ flex: 1 }} />
        {button("Decline", false)}
        {isPolarisSend(request) ? null : button("Approve", true)}
      </View>
    </View>
  );
}
