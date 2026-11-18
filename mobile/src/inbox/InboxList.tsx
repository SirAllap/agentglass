/*
 * The Inbox list: four segments over one already-ranked list.
 *
 * The segments do not ask the computer again — they hide rows, which is the
 * whole point of sorting once. "Decisions" is the three sources that ask for an
 * answer (a gate, a settings request, a plan); "Reviews" is what other people
 * and the machine did (a review asked of you, a watch that fired); "Agents" is
 * whatever is stopped on somebody. The counts are the rows each segment hides or
 * shows, so tapping a segment can never reveal a different number than the one
 * on it.
 *
 * ── decisions first, then the news ───────────────────────────────────────
 * A plan waiting for Go is drawn as its own card above everything else, and the
 * rest is under "Since you last looked". The mock draws that split because the
 * two are different errands: one is a thing stopped until you answer, the other
 * is what happened while you were away. The list is still ONE list — the
 * segment filters both halves, and the count on each segment is the rows it
 * would leave.
 *
 * A route that did not answer is a line above the list, not an empty state: the
 * rows that DID answer are still true and still worth acting on.
 */
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { Host } from "../lib/host.ts";
import type { InboxItem, PlanWaiting, StoppedAgent } from "../model/inbox.ts";
import { InboxRow, Skeleton } from "./InboxRow.tsx";
import { AgentsSheet } from "./AgentsSheet.tsx";
import { WatchRuleSheet, type WatchPr } from "./WatchRuleSheet.tsx";
import { Eyebrow, Segmented, SheetRow } from "../ui.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";
import { Glyph } from "../nav/glyphs.tsx";
import { denotesDecision } from "../model/inboxSections.ts";

type Filter = "all" | "decision" | "news" | "agent";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "decision", label: "Decisions" },
  { id: "news", label: "Reviews" },
  { id: "agent", label: "Agents" },
];

const news = (item: InboxItem): boolean => item.source === "review" || item.source === "watch";

const under = (item: InboxItem, filter: Filter): boolean =>
  filter === "all" ? true
    : filter === "decision" ? denotesDecision(item)
      : filter === "news" ? news(item)
        : item.source === "agent";

/** The empty state's tile: a green mark, one sentence, and what it counted. */
function NothingWaiting({ onOpenPrs }: { onOpenPrs: () => void }): React.ReactNode {
  return (
    <View style={{ gap: SPACE.md, paddingTop: SPACE.xl }}>
      <View style={{ alignItems: "center", gap: SPACE.md, paddingHorizontal: SPACE.lg }}>
        <View style={{
          width: 52, height: 52, borderRadius: 16, alignItems: "center", justifyContent: "center",
          backgroundColor: tint(C.success, 0.14),
        }}>
          <Glyph name="check" color={C.success} size={24} weight={2.4} />
        </View>
        <Text style={{ color: C.text, fontSize: T.title, fontWeight: "700", textAlign: "center" }}>
          Nothing needs you
        </Text>
        <Text style={{ color: C.text3, fontSize: 13, lineHeight: 19, textAlign: "center" }}>
          No decisions, no reviews, no stopped agents. This is where all four kinds of waiting arrive.
        </Text>
        <Text style={{ color: C.text3, fontSize: T.small }}>Checked just now.</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open the pull requests"
        onPress={onOpenPrs}
        style={({ pressed }) => ({
          marginHorizontal: SPACE.md, minHeight: 48, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm,
          borderRadius: RADIUS.lg, backgroundColor: pressed ? C.bg3 : C.bg2,
          borderWidth: 1, borderColor: C.border, flexDirection: "row", alignItems: "center", gap: SPACE.sm,
        })}
      >
        <Glyph name="pr" color={C.text3} size={16} />
        <Text style={{ flex: 1, color: C.text2, fontSize: T.small }}>Your open pull requests are still moving.</Text>
        <Text style={{ color: C.text3, fontSize: T.small }}>PRs</Text>
      </Pressable>
    </View>
  );
}

export function InboxList({ items, missing, loading, host, plans, agents, onAnswered, onReload, onAck }: {
  items: InboxItem[];
  missing: string[];
  loading: boolean;
  host: Host;
  /** The read behind the plan cards, so a Go card draws the launch line the
   *  list route computed rather than guessing one. */
  plans: PlanWaiting[];
  /** The roster's rows — the same `/agents/board` answer the bell counts. */
  agents: StoppedAgent[];
  onAnswered: () => void;
  onReload: () => void;
  onAck: (seq: number) => void;
}): React.ReactNode {
  const [filter, setFilter] = useState<Filter>("all");
  const router = useRouter();
  const [watch, setWatch] = useState<WatchPr | null>(null);
  const [roster, setRoster] = useState(false);

  const shown = useMemo(() => items.filter((i) => under(i, filter)), [items, filter]);
  const decisions = useMemo(() => shown.filter(denotesDecision), [shown]);
  const rest = useMemo(() => shown.filter((i) => !denotesDecision(i)), [shown]);
  const options = useMemo(() => FILTERS.map((f) => ({
    ...f,
    count: items.filter((i) => under(i, f.id)).length,
  })), [items]);
  const planOf = useMemo(() => new Map(plans.map((p) => [p.id, p])), [plans]);

  const row = (item: InboxItem): React.ReactNode => (
    <InboxRow
      item={item}
      host={host}
      plan={item.action.kind === "plan" ? planOf.get(item.action.id) : undefined}
      onAnswered={onAnswered}
      onAck={onAck}
      onWatch={setWatch}
    />
  );

  return (
    <View style={{ flex: 1, gap: SPACE.md }}>
      <Segmented value={filter} onChange={setFilter} options={options} />
      {missing.length ? (
        <Text accessibilityLiveRegion="polite" style={{ color: C.error, fontSize: T.small }}>{missing.join(" ")}</Text>
      ) : null}
      <FlatList
        data={loading && !items.length ? [] : rest}
        style={{ flex: 1 }}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ gap: SPACE.sm, paddingBottom: SPACE.xl }}
        ListHeaderComponent={
          loading && !items.length ? (
            <View style={{ gap: SPACE.sm }}>
              <Text style={{ color: C.text3, fontSize: T.small, textAlign: "center", paddingBottom: SPACE.xs }}>
                Pull to refresh
              </Text>
              {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} />)}
            </View>
          ) : (
            <View style={{ gap: SPACE.sm }}>
              {decisions.map((item) => <View key={item.id}>{row(item)}</View>)}
              {rest.length ? (
                <View style={{ paddingTop: decisions.length ? SPACE.sm : 0 }}>
                  <Eyebrow text="Since you last looked" style={{ paddingTop: 0 }} />
                </View>
              ) : null}
            </View>
          )
        }
        ListEmptyComponent={
          loading
            ? null
            : shown.length === 0 ? (
              items.length === 0 ? (
                <NothingWaiting onOpenPrs={() => router.push("/prs")} />
              ) : (
                <Text style={{ color: C.text3, fontSize: T.body, paddingTop: SPACE.lg }}>
                  Nothing under {FILTERS.find((f) => f.id === filter)?.label ?? "this"}.
                </Text>
              )
            ) : null
        }
        ListFooterComponent={(
          <View style={{ paddingTop: SPACE.sm }}>
            <SheetRow
              label="Every agent"
              sub="What is running and what each one last said — read-only"
              onPress={() => setRoster(true)}
            />
          </View>
        )}
        renderItem={({ item }) => <>{row(item)}</>}
      />

      {/* Two sheets, both one level deep from a row: the rules a fire belongs to
          and the roster the Agents segment is about. */}
      <WatchRuleSheet
        open={watch !== null}
        onClose={() => setWatch(null)}
        host={host}
        pr={watch}
        mayWrite={host.scope === "full"}
        onArmed={onReload}
      />
      <AgentsSheet
        open={roster}
        onClose={() => setRoster(false)}
        agents={agents}
        loading={loading}
        onTerminal={() => { setRoster(false); router.push("/terminal"); }}
      />
    </View>
  );
}
