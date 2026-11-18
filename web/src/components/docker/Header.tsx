/*
 * The Docker view's one 48px bar. Every control is 28px (the kit's rung), and
 * which ones show depends on the section and on whether the daemon answers: a
 * downed daemon keeps the bar but turns the filter and the view switches off,
 * because there is nothing live to filter.
 */
import { useRef, useState } from "react";
import type { freshness, GroupBy, Layout, ScopeLine, Situation } from "../../lib/dockerView.ts";
import { CaretIcon, ListIcon, LockIcon, MoreIcon, PlayIcon, PowerIcon, RefreshIcon, SearchIcon, SparkleIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, IconButton, RefreshButton, INPUT_STYLE, BAR_INPUT, Segmented } from "../workspace/Chrome.tsx";
import { AnchoredMenu } from "../AnchoredMenu.tsx";
import { Item } from "./RowMenu.tsx";
import { VIEW_HEADER_H, viewHeaderClass, viewHeaderStyle } from "../workspace/ViewHeader.tsx";

export function DockerHeader({
  situation, version, fresh, scope, q, onQ, section = "containers", groupBy, onGroupBy, layout, onLayout,
  readOnly, onRefresh, refreshing, onMeasure, analyze, bulk, showFilter, showView, back,
}: {
  situation: Situation; version: string | null; fresh: ReturnType<typeof freshness>; scope: ScopeLine | null;
  q: string; onQ: (v: string) => void; section?: string;
  groupBy: GroupBy; onGroupBy: (g: GroupBy) => void;
  layout: Layout; onLayout: (l: Layout) => void;
  readOnly: boolean; onRefresh: () => void; refreshing: boolean;
  /** The Disk section's own refresh: `docker system df` is slow, so it is asked for by name. */
  onMeasure?: () => void;
  /** "Analyze with agent": opens a guided cleanup in a new tab. `title` is the tooltip, or the reason it is off. */
  analyze?: { onClick: () => void; disabled: boolean; tip: string; pending: boolean };
  /** One verb for every container of the project in view. Present only while
   *  there is something for it to do: Stop all while any is live, Start all
   *  once none is. */
  bulk?: { verb: "stop" | "start"; n: number; pending: boolean; disabled: boolean; title: string; onClick: () => void } | null;
  /** Filter box shown (the Containers section only: it filters containers). */
  showFilter: boolean;
  /** By stack and the layout item shown (the Containers section only). */
  showView: boolean;
  /** Present when a container is open full width: the way back to the list. */
  back: (() => void) | null;
}) {
  const down = situation === "down";
  const idle = down || situation === "loading" || situation === "empty";
  const installed = situation !== "notinstalled";
  const moreRef = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState(false);
  const bulkOn = !!bulk && bulk.n > 0;
  const hasMenu = installed && (showView || !!analyze || bulkOn);
  return (
    // One line while it fits, two when it does not: from about 1000px down the
    // fixed-width controls on the right painted over the filter, and below 700
    // the last of them left the window with nothing to scroll.
    <div className={`${viewHeaderClass} dk-hdr flex-wrap`}
      style={{ ...viewHeaderStyle, gap: 8, paddingLeft: 12, paddingRight: 12, rowGap: 6, height: "auto", minHeight: VIEW_HEADER_H, maxHeight: "none", paddingTop: 6, paddingBottom: 6 }}>
      {installed && back && (
        <IconButton onClick={back} title="Back to all containers (Esc)" bare><span style={{ display: "flex", transform: "rotate(90deg)" }}><CaretIcon size={ICON.md} /></span></IconButton>
      )}
      <h2 className="sr-only">Docker</h2>
      {installed && !down && version && <span style={{ fontSize: 11, color: "var(--text3)" }}>Engine {version}</span>}
      {installed && (
        <span className="dk-fresh" data-warn={fresh.warn || undefined}
          data-tip={down ? "Cannot reach the daemon. agentglass watches the socket, so there is no timer: this fills in the moment Docker is back."
            : "Docker tells agentglass when something changes, so there is no timer."}>
          <i className="dk-live" />{fresh.text}
        </span>
      )}
      {installed && !down && situation !== "loading" && scope && (
        <span className="dk-scope" data-all={scope.all || undefined} data-tip={scope.title}>
          {scope.before}<b>{scope.project}</b>{scope.after}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {installed && showFilter && (
        <div style={{ position: "relative", flex: "1 1 140px", maxWidth: 230, minWidth: 0 }}>
          <span style={{ position: "absolute", left: 9, top: 7, color: "var(--text3)", pointerEvents: "none" }}><SearchIcon size={ICON.sm} /></span>
          <input value={q} onChange={(e) => onQ(e.target.value)} placeholder={`Filter ${section}…`} aria-label={`Filter ${section}`}
            data-tip="Filters by name, worktree, branch or port" spellCheck={false} autoComplete="off" disabled={idle}
            className={`w-full ${BAR_INPUT}`} style={{ ...INPUT_STYLE, paddingLeft: 28 }} />
        </div>
      )}
      {installed && showView && (
        <>
          <Segmented track label="Group containers" disabled={idle || !!back} value={groupBy} onChange={onGroupBy}
            options={[{ id: "stack", label: "By stack", title: "Group by compose project" }, { id: "worktree", label: "By worktree", title: "Group by the checkout each container came from" }]} />
        </>
      )}
      {readOnly && installed && (
        <span className="dk-ro" data-tip="This instance has writes turned off"><LockIcon size={ICON.xs} />Read-only</span>
      )}
      {installed && section === "disk" && onMeasure
        ? <Button onClick={onMeasure} disabled={refreshing} title="Ask Docker how much space everything takes, ignoring the short cache"><span className={refreshing ? "dk-spin" : undefined} style={{ display: "inline-flex" }}><RefreshIcon size={ICON.sm} /></span>Measure again</Button>
        : installed && <RefreshButton onRefresh={onRefresh} spinning={refreshing} title="Refresh" label="Refresh" />}
      {hasMenu && (
        <>
          <span ref={moreRef} style={{ display: "inline-flex" }}><IconButton onClick={() => setMenu((v) => !v)} title="More: layout, analyze with agent, stop or start all" label="More" hasPopup expanded={menu}><MoreIcon size={ICON.sm} /></IconButton></span>
          {menu && (
            <AnchoredMenu anchor={moreRef} minWidth={220} onClose={() => setMenu(false)}>
              {showView && <Item icon={<ListIcon size={ICON.sm} />} label={layout === "split" ? "Layout: full-width list" : "Layout: list and container side by side"} disabled={down}
                reason="Switch between the full-width list and the split view" onClick={() => { setMenu(false); onLayout(layout === "split" ? "list" : "split"); }} />}
              {analyze && <Item icon={<SparkleIcon size={ICON.sm} />} label="Analyze with agent" disabled={analyze.disabled || analyze.pending} reason={analyze.tip}
                onClick={() => { setMenu(false); analyze.onClick(); }} />}
              {bulkOn && bulk && <Item icon={bulk.verb === "stop" ? <PowerIcon size={ICON.sm} /> : <PlayIcon size={ICON.xs} />}
                label={bulk.verb === "stop" ? "Stop all" : "Start all"} disabled={bulk.disabled || bulk.pending} danger={bulk.verb === "stop"} reason={bulk.title}
                onClick={() => { setMenu(false); bulk.onClick(); }} />}
            </AnchoredMenu>
          )}
        </>
      )}
    </div>
  );
}
