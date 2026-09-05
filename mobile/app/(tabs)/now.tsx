/*
 * Now: what wants you, in order.
 *
 * A queue rather than a dashboard, and the difference is that this is
 * something you can empty. Every card is one decision carrying its own action,
 * and answering it takes the card out of the list.
 *
 * ── why this is no longer the first screen ────────────────────────────────
 * Because of the sentence in `ListEmptyComponent` below, which is true and was
 * written on purpose: "This screen is meant to be empty most of the time." A
 * screen that aspires to be empty is a bad thing to open an app on. So Home
 * opens the app and this is one tap in, from the band at the top of it —
 * kept whole, with its full list, still a tab (see src/nav/bar.ts) so that the
 * bar stays up and the terminal stays one tap away from here too.
 *
 * The band is the top of this list, said in one line. What it never becomes is
 * a second copy of the queue: the count it shows is `waitingItems`, which is
 * this file's own rule, imported.
 *
 * The split at the top of the list is `waiting` — something is stopped and only
 * a person restarts it — not tone. An agent held at a gate is paused: nothing
 * proceeds until somebody taps Allow. A pull request being ready is true,
 * useful, and waiting on nobody. Mixing the two produced a notifications inbox,
 * which everybody already has.
 */
import { useCallback, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { newsItems, waitingItems, type NowItem } from "../../src/model/nowQueue.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { useQueue } from "../../src/state/use-queue.ts";
import { Btn, Card, Label, Note } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T, toneColor } from "../../src/theme.ts";

/** "4m", "2h", "3d" — the age of a thing, in the least space that is honest. */
function age(ts: number | undefined, now: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function GateActions({ item, onDone }: { item: NowItem; onDone: () => void }): React.ReactNode {
  const { host } = useAgentglass();
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (item.origin.t !== "gate" || !host) return null;
  const id = item.origin.gate.id;

  const decide = async (decision: "allow" | "deny"): Promise<void> => {
    setBusy(decision);
    setFailed(null);
    // A short buzz on the way out, not on the way back: the answer is what the
    // person did, and confirming it a second later reads as a second event.
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const answer = await ask<{ ok: boolean; error?: string }>(host, "/gate/decide", {
      method: "POST",
      body: { id, decision },
    });
    setBusy(null);
    if (!answer.ok) { setFailed(answer.error); return; }
    if (!answer.value.ok) {
      // The interesting failure: something already resolved it — the timeout,
      // or somebody at the desk. Saying so beats a button that does nothing.
      setFailed(answer.value.error || "Something already answered this one.");
      return;
    }
    onDone();
  };

  return (
    <View style={{ gap: SPACE.sm }}>
      <View style={{ flexDirection: "row", gap: SPACE.sm }}>
        <Btn label="Allow" tone="good" busy={busy === "allow"} disabled={busy === "deny"}
          style={{ flex: 1 }} onPress={() => { void decide("allow"); }} />
        <Btn label="Deny" tone="danger" busy={busy === "deny"} disabled={busy === "allow"}
          style={{ flex: 1 }} onPress={() => { void decide("deny"); }} />
      </View>
      {failed ? <Note tone="bad">{failed}</Note> : null}
    </View>
  );
}

function Item({ item, now, onDone }: { item: NowItem; now: number; onDone: () => void }): React.ReactNode {
  const tint = toneColor(item.tone);
  return (
    <Card style={{ borderLeftWidth: 3, borderLeftColor: tint }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{
          color: tint, fontSize: T.eyebrow, letterSpacing: 0.8, textTransform: "uppercase",
          fontWeight: "700", flexShrink: 1,
        }}>{item.kind}</Text>
        <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{age(item.ts, now)}</Text>
      </View>

      <Text style={{ color: C.text, fontSize: T.title, fontWeight: "600" }}>{item.title}</Text>
      {item.sub ? <Note>{item.sub}</Note> : null}

      {item.code ? (
        <View style={{ backgroundColor: C.bg, borderRadius: RADIUS.sm, padding: SPACE.sm }}>
          {/* Verbatim, and never wrapped into something that reads like a
              different command: this is what an agent is asking to run. */}
          <Text style={{ color: C.text2, fontFamily: MONO, fontSize: T.small }} numberOfLines={6}>
            {item.code}
          </Text>
        </View>
      ) : null}

      <GateActions item={item} onDone={onDone} />
    </Card>
  );
}

export default function NowScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { fleet, live, refresh, host } = useAgentglass();
  const queue = useQueue(fleet);
  const waiting = waitingItems(queue);
  const news = newsItems(queue);
  const [pulling, setPulling] = useState(false);

  const onRefresh = useCallback((): void => {
    setPulling(true);
    refresh();
    // The refresh is fire-and-forget in the store, so the spinner is on a
    // timer rather than on the request. Lying for 600ms beats plumbing a
    // promise through for a gesture nobody measures.
    setTimeout(() => setPulling(false), 600);
  }, [refresh]);

  const rows: (NowItem | { divider: string })[] = [
    ...waiting,
    ...(news.length ? [{ divider: "Worth knowing" }] : []),
    ...news,
  ];

  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => ("divider" in row ? `d:${row.divider}` : row.id)}
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }}
      refreshControl={
        <RefreshControl refreshing={pulling} onRefresh={onRefresh} tintColor={C.text3} />
      }
      ListHeaderComponent={
        <View style={{ gap: SPACE.xs, paddingBottom: SPACE.sm }}>
          <Text style={{ color: C.text, fontSize: T.display, fontWeight: "700", lineHeight: 31 }}>
            {waiting.length === 0
              ? "Nothing is waiting on you"
              : `${waiting.length} ${waiting.length === 1 ? "thing wants" : "things want"} you`}
          </Text>
          <Note tone={fleet.error ? "bad" : "quiet"}>
            {fleet.error
              ? fleet.error
              : live === "open"
                ? host?.label ?? "Connected"
                : live === "connecting" ? "Reconnecting…" : "Offline"}
          </Note>
        </View>
      }
      ListEmptyComponent={
        fleet.at === 0
          ? null
          : (
            <Card>
              <Label text="Empty" />
              <Note>
                No gate is held, nothing has stopped and no container is down. This screen is
                meant to be empty most of the time.
              </Note>
            </Card>
          )
      }
      renderItem={({ item: row }) =>
        "divider" in row
          ? <View style={{ paddingTop: SPACE.md }}><Label text={row.divider} /></View>
          : <Item item={row} now={fleet.at || Date.now()} onDone={refresh} />}
    />
  );
}
