/*
 * One lane: the cards it has room for, and what it left out.
 *
 * No title row: the strip above the board already names the lane, counts it,
 * and carries its sentence as the tab's hint. A second answer to "where am I"
 * cost 48 points of cards and could disagree with the first. The ruler row is
 * drawn only while it has something to say — cards behind a rule, or the
 * landing lane's Sync — so a quiet lane is all cards.
 *
 * The cap is a door rather than a dead end: the footer says how many are past
 * `LANE_CAP` and opens the list, which is where every one of them is drawn.
 *
 * A card asks for what it draws and nothing else: the compare behind its branch
 * (`/prs/behind`, three at a time and five minutes of memory) and its tracker
 * card when the row's copy has gone stale. Both live here because a card that is
 * not on screen is not drawn, and this is where "on screen" is decided.
 */
import { useState, useSyncExternalStore } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import type { PrSummary } from "../../../shared/types.ts";
import type { Suggested } from "../../../shared/prLanes.ts";
import type { JiraReach } from "../../../shared/taskref.ts";
import type { Host } from "../lib/host.ts";
import { emptyLaneWords, type BoardCard, type BoardLane } from "../model/prBoard.ts";
import { footerPress } from "../model/prActions.ts";
import { PrCard } from "../review/PrCard.tsx";
import { askingBehind, behindFailed, behindOf, behindVersion, subscribeBehind } from "../state/pr-behind.ts";
import { usePrCard } from "../state/pr-cards.ts";
import { C, RADIUS, SPACE, T } from "../theme.ts";
import { TAP } from "../ui.tsx";

export function LaneColumn({ lane, width, now, repo, host, root, tracked, jira, filtered, refreshing, onRefresh, onOpen, onMore, onSync, onAction, onMenu, mayWrite }: {
  lane: BoardLane;
  width: number;
  now: number;
  /** The board's repository name, which every card's id line says. */
  repo?: string;
  host: Host;
  /** The repository's checkout root: the key the compare is stored under. */
  root: string;
  /** Whether a tracker is connected (null while unknown). */
  tracked: boolean | null;
  jira: JiraReach | null;
  /** Whether the sheet is narrowing the board: an empty lane then says why. */
  filtered: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (pr: PrSummary) => void;
  /** Open the list, where the cards past the cap are drawn. */
  onMore: () => void;
  /** Sync every behind branch in this lane. Only the landing lane gets one:
   *  a branch nobody is about to land has no reason to be moved today. */
  onSync?: () => void;
  /** The card's own press, with the action the lane implies. A read-only
   *  pairing falls back to opening the pull request — see model/prActions.ts. */
  onAction?: (pr: PrSummary, action: Suggested) => void;
  /** The card's dots: the sheet of what it can do (mock 62). */
  onMenu?: (pr: PrSummary) => void;
  /** Whether this phone may write at all. */
  mayWrite: boolean;
}): React.ReactNode {
  const [peek, setPeek] = useState(false);
  const cards = peek ? [...lane.cards, ...lane.hidden] : lane.cards;
  const ruler = onSync !== undefined || lane.hidden.length > 0;
  return (
    <View style={{ width, paddingHorizontal: SPACE.lg }}>
      {ruler ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: TAP }}>
          {lane.hidden.length ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${lane.hidden.length} hidden by your rules${peek ? ", shown" : ""}. ${peek ? "Hide them again" : "Peek at them"}`}
              accessibilityState={{ expanded: peek }}
              onPress={() => setPeek((v) => !v)}
              style={({ pressed }) => ({
                minHeight: TAP, flexDirection: "row", alignItems: "center", gap: SPACE.sm, opacity: pressed ? 0.6 : 1,
              })}
            >
              <View style={{ flexDirection: "row", gap: 3 }}>
                {[0, 1, 2].map((i) => <View key={i} style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: C.text4 }} />)}
              </View>
              <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small, flexShrink: 1 }}>
                {lane.hidden.length} hidden by your rules
              </Text>
              <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "700" }}>{peek ? "Hide" : "Peek"}</Text>
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }} />
          {onSync ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Sync the branches in ${lane.label}`}
              onPress={onSync}
              style={({ pressed }) => ({
                minHeight: TAP, minWidth: TAP, justifyContent: "center", alignItems: "flex-end",
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "700" }}>Sync</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <FlatList
        style={{ flex: 1 }}
        data={cards}
        keyExtractor={(card) => card.pr.url || String(card.pr.number)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ gap: SPACE.sm, paddingTop: SPACE.sm, paddingBottom: SPACE.md, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.text3} />}
        ListEmptyComponent={
          <Text style={{ color: C.text4, fontSize: T.small, lineHeight: 18, paddingTop: SPACE.sm }}>
            {lane.hidden.length && !peek ? "Everything here is behind your rules." : emptyLaneWords(lane.id, filtered)}
          </Text>
        }
        ListFooterComponent={lane.more > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${lane.more} more in ${lane.label}. Opens the list.`}
            onPress={onMore}
            style={({ pressed }) => ({
              minHeight: TAP, alignItems: "center", justifyContent: "center",
              borderWidth: 1, borderStyle: "dashed", borderColor: C.border2, borderRadius: RADIUS.md,
              backgroundColor: pressed ? C.bg3 : "transparent",
            })}
          >
            <Text style={{ color: C.text3, fontSize: T.small, fontWeight: "600" }}>
              {lane.more} more · open the list
            </Text>
          </Pressable>
        ) : null}
        renderItem={({ item }) => (
          <LandedCard
            item={item}
            now={now}
            forMe={lane.id === "review"}
            repo={repo}
            host={host}
            root={root}
            tracked={tracked}
            jira={jira}
            onOpen={onOpen}
            onAction={onAction}
            onMenu={onMenu}
            mayWrite={mayWrite}
          />
        )}
      />
    </View>
  );
}

/** One card of a lane, asking for the two facts it draws. */
function LandedCard({ item, now, forMe, repo, host, root, tracked, jira, onOpen, onAction, onMenu, mayWrite }: {
  item: BoardCard;
  now: number;
  forMe: boolean;
  repo?: string;
  host: Host;
  root: string;
  tracked: boolean | null;
  jira: JiraReach | null;
  onOpen: (pr: PrSummary) => void;
  onAction?: (pr: PrSummary, action: Suggested) => void;
  onMenu?: (pr: PrSummary) => void;
  mayWrite: boolean;
}): React.ReactNode {
  // A compare landing repaints the cards: the snapshot is the store's version,
  // which changes on every answer.
  useSyncExternalStore(subscribeBehind, behindVersion);
  const { state } = usePrCard(host, item.pr, tracked, jira);
  const pr = item.pr;
  return (
    <PrCard
      pr={pr}
      now={now}
      forMe={forMe}
      repo={repo}
      unread={null}
      behind={behindOf(host, root, pr.number)}
      asking={askingBehind(host, root, pr.number)}
      failed={behindFailed(host, root, pr.number)}
      card={state}
      filed={item.filed}
      action={item.action}
      onOpen={() => onOpen(pr)}
      onAction={onAction ? () => onAction(pr, footerPress(item.action, mayWrite)) : undefined}
      onMenu={onMenu ? () => onMenu(pr) : undefined}
    />
  );
}
