// Starboard: the control deck. Replaces the Dashboard and is a view like any
// other: closed, it draws nothing and asks for nothing (`active`).
//
// Layout is the approved mockup's: three columns, three reflow levels chosen
// by the width of the view itself (container query), not the window, so the
// rail's width does not move a breakpoint. Every number carries a trust mark
// and a hover/focus card (lib/starboardTips.ts, drawn by TipHost). Nothing is
// a count the engine cannot yet back is left out or drawn dashed as "proposed".
//
// Crew, Orrery, Needs you, Tools and Cost live in StarboardPanels.tsx and read
// the Lantern board and the stats. Ceiling: a Stalled? tile is drawn only once
// the engine supplies a value; until then it is left out, not shown as a dash.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { WatchEvent, SessionRollup, StatsSummary } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { usePoll } from "../lib/usePoll.ts";
import { Throughput } from "./Throughput.tsx";
import { Alerts } from "./Alerts.tsx";
import { Feed } from "./Feed.tsx";
import { useFleetVerdict } from "../lib/useFleetVerdict.ts";
import { Crew, Orrery, NeedsYou, Tools, Cost, useCrewCounts, useBoard } from "./StarboardPanels.tsx";
import { subscribeProviderUsage, providerUsage } from "../lib/usageStore.ts";
import { coreRows } from "../lib/accountStore.ts";
import { spendSeries, sparkPath, fiveHour, quotaLines, untilReset, stalledCount, clockWords } from "../lib/starboardKpi.ts";
import { sbTip, sbQuotaTip, type SbTip } from "../lib/starboardTips.ts";
import { Select } from "./Select.tsx";
import type { ReactNode } from "react";
import type { AgentCard, Alert } from "../lib/derive.ts";
import { CrossIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { EDGE, Button } from "./workspace/Chrome.tsx";
import { DashIcon } from "./workspace/icons.tsx";

/** "unknown" is a real bucket (a session whose model never resolved), and it
 *  reads as a value rather than as a gap when it is spelled out. */
const providerLabel = (p: string) => (p === "unknown" ? "Unknown" : p);

const WINDOWS = [
  { label: "15m", ms: 900_000 },
  { label: "1h", ms: 3_600_000 },
  { label: "6h", ms: 21_600_000 },
  { label: "24h", ms: 86_400_000 },
  { label: "7d", ms: 604_800_000 },
  { label: "30d", ms: 2_592_000_000 },
  { label: "All", ms: 0 },
];

export type DashFilter = { app: string; type: string; provider: string };

export function StarboardView({
  active, events, visibleEvents, agents, alerts, stats, sessionProvider, providers,
  windowMs, onWindow, filter, onFilter, onClearFilter, retentionDays, refreshing,
  startedAt, epm, onSelectEvent, onSelectSession, onOpenLantern,
}: {
  active: boolean;
  events: WatchEvent[];
  visibleEvents: WatchEvent[];
  agents: AgentCard[];
  alerts: Alert[];
  stats: StatsSummary | null;
  sessionProvider: Map<string, string>;
  providers: string[];
  windowMs: number;
  onWindow: (ms: number) => void;
  filter: DashFilter;
  onFilter: (f: DashFilter) => void;
  onClearFilter: () => void;
  retentionDays?: number;
  /** The window was just changed and its numbers have not arrived: the old ones stay up, dimmed. */
  refreshing?: boolean;
  startedAt: number;
  epm: number;
  onSelectEvent: (e: WatchEvent | null) => void;
  onSelectSession: (s: { id: string; app: string }) => void;
  onOpenLantern: () => void;
}) {
  /**
   * The facet lists, fetched HERE and only while this view is open.
   *
   * They used to be polled from the app root every twenty seconds for the whole
   * life of the process, to fill two dropdowns that exist on this screen alone.
   */
  const [opts, setOpts] = useState<{ source_apps: string[]; hook_event_types: string[] }>({ source_apps: [], hook_event_types: [] });
  const loadOpts = () => api.filterOptions().then(setOpts).catch(() => {});
  useEffect(() => { if (active) void loadOpts(); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  usePoll(active, () => { void loadOpts(); }, 20_000);

  /* Read once: one screen, one count. */
  const fleet = useFleetVerdict();
  const t = stats?.totals;
  /* Ages ("quiet 3 min") advance on a slow tick; the board and stats re-render this on their own events. */
  const [, setTick] = useState(0);
  usePoll(active, () => setTick((n) => n + 1), 30_000);
  const now = Date.now();
  const crew = useCrewCounts(now);
  const spend = spendSeries(stats?.timeline);
  const quotaRows = coreRows(useSyncExternalStore(subscribeProviderUsage, providerUsage, () => null));
  const five = fiveHour(quotaRows);
  const quotaTip = sbQuotaTip(quotaLines(quotaRows));
  const stalled = stalledCount(useBoard());
  const clock = clockWords(now);
  const up = Math.max(0, Math.floor((now - startedAt) / 60_000));

  const hasFilter = filter.app || filter.type || filter.provider;
  const selStyle = {
    background: "color-mix(in srgb, var(--bg3) 40%, transparent)",
    border: EDGE,
    color: "var(--text2)",
  };

  return (
    <div className="sb h-full min-h-0" data-busy={refreshing ? "1" : undefined} aria-busy={refreshing || undefined}>
      <div className="sb-screen" data-sb="screen">
        <header className="sb-head">
          <div className="sb-brand">
            <span className="sb-mark"><DashIcon size={ICON.lg} /></span>
            <div><h1>Starboard</h1><small>agentglass</small></div>
          </div>
          <div className="sb-verdict">
            <span className="sb-chip" data-tip={sbTip("working")} tabIndex={0}><i className="sb-dot" data-s="ok" /><b>{fleet?.counts.running ?? "–"}</b> working</span>
            <span className="sb-chip" data-tip={sbTip("waiting")} tabIndex={0}><i className="sb-dot" data-s="warn" /><b>{fleet?.counts.need ?? "–"}</b> waiting on you</span>
            <span className="sb-chip" data-tip={sbTip("quiet")} tabIndex={0}><i className="sb-dot" data-s="off" data-ring="1" /><b>{crew.quiet}</b> quiet</span>
            <span className="sb-chip" data-tip={sbTip("finished")} tabIndex={0}><i className="sb-dot" data-s="off" /><b>{crew.done}</b> finished</span>
          </div>
          <div className="sb-controls">
            <span className="sb-seg" role="group" aria-label="Time window">
              {WINDOWS.map((w) => {
                // A window longer than the retention is answered from what is kept,
                // not from what it says — so it is marked rather than silently wrong.
                const beyond = !!retentionDays && w.ms > retentionDays * 86_400_000;
                return (
                  <Button key={w.label} size="compact" data-wait={refreshing && windowMs === w.ms ? "1" : undefined} on={windowMs === w.ms} aria-pressed={windowMs === w.ms} onClick={() => onWindow(w.ms)}
                    data-tip={beyond ? `Events are kept for ${retentionDays} days, so this window is answered from the last ${retentionDays}d.` : undefined}>
                    {w.label}{beyond && <sup className="ml-px text-[7px] opacity-70" aria-hidden>*</sup>}
                  </Button>
                );
              })}
            </span>
            <Select value={filter.app} style={selStyle}
              options={[{ value: "", label: "All apps" }, ...opts.source_apps.map((a) => ({ value: a, label: a }))]}
              onChange={(v) => onFilter({ ...filter, app: v })} />
            <Select value={filter.type} style={selStyle}
              options={[{ value: "", label: "All events" }, ...opts.hook_event_types.map((x) => ({ value: x, label: x }))]}
              onChange={(v) => onFilter({ ...filter, type: v })} />
            {/* Reserved when absent: a control that comes and goes under the pointer moves the ones beside it. */}
            <span style={{ visibility: providers.length > 1 ? "visible" : "hidden" }}>
              <Select value={filter.provider} style={selStyle}
                options={[{ value: "", label: "All providers" }, ...providers.map((p) => ({ value: p, label: providerLabel(p) }))]}
                onChange={(v) => onFilter({ ...filter, provider: v })} />
            </span>
            <span style={{ visibility: hasFilter ? "visible" : "hidden" }}>
              <Button tone="warn" size="compact" className="shrink-0" onClick={onClearFilter}>Clear<CrossIcon size={ICON.xs} /></Button>
            </span>
          </div>
          <div className="sb-clock" data-tip={sbTip("clock")} tabIndex={0}><b>{clock.time}</b><span>{clock.date}</span></div>
        </header>

        <section className="sb-kpi" aria-label="Key numbers" style={{ opacity: fleet?.stale ? 0.6 : 1 }}>
          <Tile tip="spend" label="Spend" n={t ? `~$${t.cost_usd.toFixed(2)}` : "–"} sub={`estimated · ${(t?.sessions ?? 0).toLocaleString()} sessions`} hero spark={spend ? sparkPath(spend) : undefined} />
          <Tile tip="working" label="Working" n={fleet?.counts.running ?? "–"} sub="from the Lantern board" />
          <Tile tip="waiting" label="Waiting on you" n={fleet?.counts.need ?? "–"} sub="same as the rail pip" warn={!!fleet?.counts.need} />
          <Tile tip="eventsMin" label="Events / min" n={epm} sub="live, last 60 s" />
          <Tile tip="tools" label="Tools run" n={t ? t.tool_calls.toLocaleString() : "–"} sub={`${(t?.events ?? 0).toLocaleString()} events`} />
          <Tile tip="failed" label="Failed" n={t ? (t.tool_errors ?? 0).toLocaleString() : "–"} sub={t && t.tool_calls ? `${((t.tool_errors ?? 0) / t.tool_calls * 100).toFixed(1)}% of tools run` : "failed tool calls"} bad={!!t?.tool_errors} />
          <Tile tip="uptime" label="Uptime" n={`${Math.floor(up / 60)} h ${String(up % 60).padStart(2, "0")} m`} sub="server" opt />
          <Tile tip="quota" tipText={quotaTip} label="Quota · 5 h" n={five ? <>{Math.round(five.used)}<small>%</small></> : "–"}
            sub={five ? (untilReset(five.resetsAt, now) ? `resets in ${untilReset(five.resetsAt, now)}` : "reset time not reported") : "no reading · sign in"} opt />
          {stalled !== null && <Tile tip="stalled" label="Stalled?" n={stalled} sub="proposed · see tooltip" proposed opt />}
        </section>

        <Crew cards={agents} now={now} />
        <Orrery now={now} working={fleet?.counts.running ?? 0} />
        <div className="sb-right">
          <NeedsYou onOpenLantern={onOpenLantern} now={now} />
          <div className="sb-slot" data-glyph="alerts" data-tip={sbTip("alerts")} tabIndex={0}>
            <Alerts alerts={alerts} agents={agents} active={active} onSelectApp={(app) => onFilter({ ...filter, app })} />
          </div>
          <Tools stats={stats} />
        </div>
        <div className="sb-feed sb-slot" data-glyph="live" data-tip={sbTip("feed")} tabIndex={0}>
          <Feed events={events} filter={filter} sessionProvider={sessionProvider} onSelect={onSelectEvent} onClearFilter={onClearFilter} />
        </div>
        <div className="sb-bot">
          <div className="sb-slot" data-glyph="thru" data-tip={sbTip("thru")} tabIndex={0}><Throughput events={visibleEvents} /></div>
          <Cost stats={stats} />
        </div>
      </div>
    </div>
  );
}

function Tile({ tipText, tip, label, n, sub, hero, proposed, opt, warn, bad, spark }: { tipText?: string; spark?: string; tip: SbTip; label: string; n: ReactNode; sub: string; hero?: boolean; proposed?: boolean; opt?: boolean; warn?: boolean; bad?: boolean }) {
  return (
    <div className="sb-tile" data-tip={tipText ?? sbTip(tip)} tabIndex={0} data-hero={hero ? "1" : undefined} data-spark={spark ? "1" : undefined} data-proposed={proposed ? "1" : undefined} data-opt={opt ? "1" : undefined} data-warn={warn ? "1" : undefined} data-bad={bad ? "1" : undefined}>
      <div className="sb-t">{label}<i className="sb-tm" data-m={proposed ? "p" : tip === "spend" ? "e" : "m"} /></div>
      <div className="sb-n">{n}</div>
      <div className="sb-s" data-tip={sub}>{sub}</div>
      {spark && <svg className="sb-spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden><path d={spark} /></svg>}
    </div>
  );
}
