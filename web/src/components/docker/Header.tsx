/*
 * The Docker view's one 48px bar. Every control is 28px (the kit's rung), and
 * which ones show depends on the section and on whether the daemon answers: a
 * downed daemon keeps the bar but turns the filter and the view switches off,
 * because there is nothing live to filter.
 */
import type { freshness, GroupBy, Layout, ScopeLine, Situation } from "../../lib/dockerView.ts";
import { CaretIcon, ListIcon, LockIcon, RefreshIcon, SearchIcon, SparkleIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button, Chip, IconButton, RefreshButton, INPUT_STYLE, BAR_INPUT, Segmented } from "../workspace/Chrome.tsx";
import { viewHeaderClass, viewHeaderStyle } from "../workspace/ViewHeader.tsx";

export function DockerHeader({
  situation, version, fresh, scope, q, onQ, section = "containers", groupBy, onGroupBy, layout, onLayout, dense, onDense,
  readOnly, onRefresh, refreshing, onMeasure, analyze, showFilter, showView, back,
}: {
  situation: Situation; version: string | null; fresh: ReturnType<typeof freshness>; scope: ScopeLine | null;
  q: string; onQ: (v: string) => void; section?: string;
  groupBy: GroupBy; onGroupBy: (g: GroupBy) => void;
  layout: Layout; onLayout: (l: Layout) => void;
  dense: boolean; onDense: () => void;
  readOnly: boolean; onRefresh: () => void; refreshing: boolean;
  /** The Disk section's own refresh: `docker system df` is slow, so it is asked for by name. */
  onMeasure?: () => void;
  /** "Analyze with agent": opens a guided cleanup in a new tab. `title` is the tooltip, or the reason it is off. */
  analyze?: { onClick: () => void; disabled: boolean; title: string; pending: boolean };
  /** Filter box shown (the Containers section only: it filters containers). */
  showFilter: boolean;
  /** By stack / layout / Dense shown (the Containers section only). */
  showView: boolean;
  /** Present when a container is open full width: the way back to the list. */
  back: (() => void) | null;
}) {
  const down = situation === "down";
  const idle = down || situation === "loading" || situation === "empty";
  const installed = situation !== "notinstalled";
  return (
    <div className={`${viewHeaderClass} dk-hdr`} style={{ ...viewHeaderStyle, gap: 8, paddingLeft: 12, paddingRight: 12 }}>
      {installed && back && (
        <IconButton onClick={back} title="Back to all containers (Esc)" bare><span style={{ display: "flex", transform: "rotate(90deg)" }}><CaretIcon size={ICON.md} /></span></IconButton>
      )}
      <h2 className="sr-only">Docker</h2>
      {installed && !down && version && <span style={{ fontSize: 11, color: "var(--text3)" }}>Engine {version}</span>}
      {installed && (
        <span className="dk-fresh" data-warn={fresh.warn || undefined}
          title={down ? "Cannot reach the daemon. agentglass watches the socket, so there is no timer: this fills in the moment Docker is back."
            : "Docker tells agentglass when something changes, so there is no timer."}>
          <i className="dk-live" />{fresh.text}
        </span>
      )}
      {installed && !down && situation !== "loading" && scope && (
        <span className="dk-scope" data-all={scope.all || undefined} title={scope.title}>
          {scope.before}<b>{scope.project}</b>{scope.after}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {installed && showFilter && (
        <div style={{ position: "relative", flex: "1 1 140px", maxWidth: 230, minWidth: 0 }}>
          <span style={{ position: "absolute", left: 9, top: 7, color: "var(--text3)", pointerEvents: "none" }}><SearchIcon size={ICON.sm} /></span>
          <input value={q} onChange={(e) => onQ(e.target.value)} placeholder={`Filter ${section}…`} aria-label={`Filter ${section}`}
            title="Filters by name, worktree, branch or port" spellCheck={false} autoComplete="off" disabled={idle}
            className={`w-full ${BAR_INPUT}`} style={{ ...INPUT_STYLE, paddingLeft: 28 }} />
        </div>
      )}
      {installed && showView && (
        <>
          <Segmented track label="Group containers" disabled={idle || !!back} value={groupBy} onChange={onGroupBy}
            options={[{ id: "stack", label: "By stack", title: "Group by compose project" }, { id: "worktree", label: "By worktree", title: "Group by the checkout each container came from" }]} />
          <Segmented track label="Layout" disabled={down} value={layout} onChange={onLayout}
            options={[{ id: "list", label: "List", title: "Full-width list; a container opens over it" }, { id: "split", label: "Split", title: "Narrow list with the container beside it" }]} />
          <Chip resting on={dense} disabled={idle || !!back} onClick={onDense}
            title={dense ? "Show each container's image again" : "Fit more containers on screen: one line per row"}><ListIcon size={ICON.xs} />Dense</Chip>
        </>
      )}
      {readOnly && installed && (
        <span className="dk-ro" title="This instance has writes turned off"><LockIcon size={ICON.xs} />Read-only</span>
      )}
      {installed && analyze && (
        <Button onClick={analyze.onClick} disabled={analyze.disabled || analyze.pending} pending={analyze.pending} title={analyze.title}><SparkleIcon size={ICON.sm} />Analyze with agent</Button>
      )}
      {installed && section === "disk" && onMeasure
        ? <Button onClick={onMeasure} disabled={refreshing} title="Ask Docker how much space everything takes, ignoring the short cache"><span className={refreshing ? "dk-spin" : undefined} style={{ display: "inline-flex" }}><RefreshIcon size={ICON.sm} /></span>Measure again</Button>
        : installed && <RefreshButton onRefresh={onRefresh} spinning={refreshing} title="Refresh" />}
    </div>
  );
}
