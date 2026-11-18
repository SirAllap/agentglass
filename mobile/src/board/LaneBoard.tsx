/*
 * The board itself: one lane per page, swiped, with the strip as the jump.
 *
 * Horizontal paging rather than five squeezed columns, because a lane at 360dp
 * has room for one card's sentence; the desktop's five columns side by side is
 * a monitor's answer. `pagingEnabled` is the gesture, and the strip is the
 * short way across — either one moves the same index, so the tab lit and the
 * lane under it cannot disagree.
 */
import { useEffect, useRef, useState } from "react";
import { FlatList, useWindowDimensions } from "react-native";
import type { PrSummary } from "../../../shared/types.ts";
import type { Suggested } from "../../../shared/prLanes.ts";
import type { JiraReach } from "../../../shared/taskref.ts";
import type { Host } from "../lib/host.ts";
import type { BoardLane } from "../model/prBoard.ts";
import { LaneColumn } from "./LaneColumn.tsx";
import { LaneStrip } from "./LaneStrip.tsx";

export function LaneBoard({ lanes, now, repo, host, root, tracked, jira, filtered, refreshing, onRefresh, onOpen, onMore, onSyncLane, onAction, onMenu, mayWrite }: {
  lanes: BoardLane[];
  now: number;
  /** The repository this board is for. */
  repo?: string;
  host: Host;
  /** The repository's checkout root, which the compare is keyed by. */
  root: string;
  /** Whether a tracker is connected (null while unknown). */
  tracked: boolean | null;
  /** What the connected Jira site says its project keys are. */
  jira: JiraReach | null;
  filtered: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (pr: PrSummary) => void;
  onMore: () => void;
  /** Sync a lane's behind branches, as N single syncs. Only the landing lane
   *  is offered it — see LaneColumn. */
  onSyncLane?: (lane: BoardLane) => void;
  /** The card's press, with what its lane implies. */
  onAction?: (pr: PrSummary, action: Suggested) => void;
  /** The card's dots: the sheet of what it can do. */
  onMenu?: (pr: PrSummary) => void;
  mayWrite: boolean;
}): React.ReactNode {
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const list = useRef<FlatList<BoardLane>>(null);
  /* The list keeps its pixel offset when the page changes width, so the lane
     under the strip after a rotate is `offset / the new width` — a different
     one. Put the same lane back, without animating. */
  const laidOut = useRef(width);
  useEffect(() => {
    if (laidOut.current === width) return;
    laidOut.current = width;
    if (index < lanes.length) list.current?.scrollToIndex({ index, animated: false });
  }, [width, index, lanes.length]);
  const pick = (next: number): void => {
    setIndex(next);
    list.current?.scrollToIndex({ index: next, animated: true });
  };
  return (
    <>
      <LaneStrip lanes={lanes} index={index} onPick={pick} />
      <FlatList
        ref={list}
        horizontal
        pagingEnabled
        data={lanes}
        keyExtractor={(lane) => lane.id}
        showsHorizontalScrollIndicator={false}
        extraData={width}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        onMomentumScrollEnd={(e) => {
          const next = Math.round(e.nativeEvent.contentOffset.x / width);
          if (next !== index) setIndex(next);
        }}
        renderItem={({ item }) => (
          <LaneColumn
            lane={item}
            width={width}
            now={now}
            repo={repo}
            host={host}
            root={root}
            tracked={tracked}
            jira={jira}
            filtered={filtered}
            refreshing={refreshing}
            onRefresh={onRefresh}
            onOpen={onOpen}
            onMore={onMore}
            onSync={item.id === "land" && onSyncLane ? () => onSyncLane(item) : undefined}
            onAction={onAction}
            onMenu={onMenu}
            mayWrite={mayWrite}
          />
        )}
      />
    </>
  );
}
