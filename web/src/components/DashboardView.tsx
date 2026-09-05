// The dashboard, whole — and now a view like any other.
//
// Not a panel was removed. What changed is where it lives and what it costs:
// it used to be the app's front door, permanently mounted under a modal
// workspace, polling `/stats` every four seconds and re-rendering fourteen
// panels on every socket flush for a screen nobody was looking at. About 1,200
// requests an hour, on the same thread that draws the terminal.
//
// So it took the `active` prop every other view already had. Closed, it draws
// nothing and asks for nothing; open, it is exactly what it always was.
//
// It also inherited the nine window buttons and the three facet selects that
// used to live in the app's header. They only ever applied here — a "last 6
// hours" filter means nothing to a file tree — and moving them in is what let
// the header shrink to a 30px strip.
import { useEffect, useState } from "react";
import type { WatchEvent, SessionRollup, StatsSummary } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { Kpis } from "./Kpis.tsx";
import { Throughput } from "./Throughput.tsx";
import { ToolMix } from "./ToolMix.tsx";
import { Radar } from "./Radar.tsx";
import { Alerts } from "./Alerts.tsx";
import { Fleet } from "./Fleet.tsx";
import { Feed } from "./Feed.tsx";
import { CostByModel } from "./CostByModel.tsx";
import { Latency } from "./Latency.tsx";
import { Sessions } from "./Sessions.tsx";
import { MissionTimeline } from "./MissionTimeline.tsx";
import { UsageBox } from "./UsageBox.tsx";
import { Select } from "./Select.tsx";
import type { AgentCard, Alert } from "../lib/derive.ts";

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

export function DashboardView({
  active, events, visibleEvents, agents, alerts, stats, sessionProvider, providers,
  windowMs, onWindow, filter, onFilter, onClearFilter, retentionDays,
  startedAt, epm, onSelectEvent, onSelectSession,
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
  startedAt: number;
  epm: number;
  onSelectEvent: (e: WatchEvent | null) => void;
  onSelectSession: (s: { id: string; app: string }) => void;
}) {
  /**
   * The facet lists, fetched HERE and only while this view is open.
   *
   * They used to be polled from the app root every twenty seconds for the whole
   * life of the process, to fill two dropdowns that exist on this screen alone.
   */
  const [opts, setOpts] = useState<{ source_apps: string[]; hook_event_types: string[] }>({ source_apps: [], hook_event_types: [] });
  useEffect(() => {
    if (!active) return;
    const load = () => api.filterOptions().then(setOpts).catch(() => {});
    load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [active]);

  const hasFilter = filter.app || filter.type || filter.provider;
  const selStyle = {
    background: "color-mix(in srgb, var(--bg3) 40%, transparent)",
    border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)",
    color: "var(--text2)",
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* The controls that only mean something here, now that they live here.
          One row, the same height as every other view's header. */}
      <div className="flex items-center gap-2 px-3 shrink-0 overflow-x-auto agw-noscrollbar"
        style={{ height: 40, borderBottom: "1px solid color-mix(in srgb, var(--text) 12%, transparent)" }}>
        <span className="text-[12.5px] font-semibold shrink-0" style={{ color: "var(--text)" }}>Dashboard</span>
        <span className="flex items-center gap-0.5 shrink-0 ml-1 p-0.5 rounded-lg"
          style={{ background: "color-mix(in srgb, var(--text) 5%, transparent)" }}>
          {WINDOWS.map((w) => {
            // A window longer than the retention is answered from what is kept,
            // not from what it says — so it is marked rather than silently wrong.
            const beyond = !!retentionDays && w.ms > retentionDays * 86_400_000;
            return (
              <button key={w.label} onClick={() => onWindow(w.ms)} className="px-2 py-0.5 rounded-md text-[10.5px]"
                title={beyond ? `Events are kept for ${retentionDays} days, so this window is answered from the last ${retentionDays}d.` : undefined}
                style={windowMs === w.ms
                  ? { background: "color-mix(in srgb, var(--primary) 22%, transparent)", color: "var(--primary-hover)" }
                  : { color: "var(--text4)" }}>
                {w.label}{beyond && <sup className="ml-px text-[7px] opacity-70" aria-hidden>*</sup>}
              </button>
            );
          })}
        </span>
        <Select value={filter.app} style={selStyle}
          options={[{ value: "", label: "All apps" }, ...opts.source_apps.map((a) => ({ value: a, label: a }))]}
          onChange={(v) => onFilter({ ...filter, app: v })} />
        <Select value={filter.type} style={selStyle}
          options={[{ value: "", label: "All events" }, ...opts.hook_event_types.map((t) => ({ value: t, label: t }))]}
          onChange={(v) => onFilter({ ...filter, type: v })} />
        {providers.length > 1 && (
          <Select value={filter.provider} style={selStyle}
            options={[{ value: "", label: "All providers" }, ...providers.map((p) => ({ value: p, label: providerLabel(p) }))]}
            onChange={(v) => onFilter({ ...filter, provider: v })} />
        )}
        {hasFilter && (
          <button onClick={onClearFilter} className="text-[10.5px] px-2 py-1 rounded-lg shrink-0 whitespace-nowrap"
            style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }}>Clear ✕</button>
        )}
      </div>

      <div className="flex-1 min-h-0 p-3 flex flex-col gap-3 overflow-auto tall:overflow-hidden agx-scroll">
        <div className="shrink-0">
          <Kpis stats={stats} agents={agents} startedAt={startedAt} epm={epm} />
        </div>

        <div className="shrink-0 min-h-0 tall:flex-1 grid grid-cols-1 xl:grid-cols-12 gap-3">
          <div className="xl:col-span-3 min-w-0 min-h-0 h-[420px] xl:h-[520px] tall:h-auto">
            <Fleet agents={agents} activeApp={filter.app} onSelect={(a) => onSelectSession({ id: a.session_id, app: a.source_app })} />
          </div>
          <div className="xl:col-span-6 min-w-0 min-h-0 grid grid-rows-[auto_400px] sm:grid-rows-[minmax(0,150px)_minmax(0,1fr)] gap-3 h-auto sm:h-[520px] tall:h-auto">
            <div className="grid grid-cols-1 sm:grid-cols-2 auto-rows-[150px] sm:auto-rows-auto gap-3 min-w-0 min-h-0">
              <Throughput events={visibleEvents} />
              <ToolMix events={visibleEvents} />
            </div>
            <div className="min-w-0 min-h-0">
              <Feed events={events} filter={filter} sessionProvider={sessionProvider} onSelect={onSelectEvent} onClearFilter={onClearFilter} />
            </div>
          </div>
          <div className="xl:col-span-3 min-w-0 min-h-0 grid grid-rows-[3fr_2fr] gap-3 h-[420px] xl:h-[520px] tall:h-auto">
            <Radar agents={agents} onSelect={(a) => onFilter({ ...filter, app: a.source_app })} />
            <Alerts alerts={alerts} agents={agents} active={active} onSelectApp={(app) => onFilter({ ...filter, app })} />
          </div>
        </div>

        {/* Money row and timeline share one grid so the Usage box can span
            both. The columns line up with the cockpit above: Usage under
            Fleet, Cost and Latency under the middle column, Sessions under
            Alerts. */}
        {/* The rows are minimums, not heights: Usage spans both of them and its
            length is set by how many quota windows the providers report, which
            is not a number this layout gets to fix. Letting the row grow is
            what keeps that panel off a scrollbar of its own. */}
        <div className="shrink-0 grid grid-cols-1 xl:grid-cols-12 gap-3 h-auto xl:grid-rows-[minmax(196px,auto)_minmax(140px,auto)]">
          <div className="xl:col-span-3 xl:row-span-2 min-w-0 min-h-0 h-auto">
            <UsageBox />
          </div>
          {/* Pinned, not auto: these three are the reason the row has a minimum
              at all, and letting them size to content grows the row for
              everyone — they are each taller than 196px if asked. Only the
              Usage cell above is allowed to ask for more. */}
          <div className="xl:col-span-3 min-w-0 min-h-0 h-[196px] xl:h-[196px]"><CostByModel stats={stats} /></div>
          <div className="xl:col-span-3 min-w-0 min-h-0 h-[196px] xl:h-[196px]"><Latency stats={stats} /></div>
          <div className="xl:col-span-3 min-w-0 min-h-0 h-[196px] xl:h-[196px]"><Sessions provider={filter.provider} active={active} /></div>
          <div className="xl:col-span-9 min-w-0 min-h-0 h-[140px] xl:h-[140px]"><MissionTimeline stats={stats} /></div>
        </div>
      </div>
    </div>
  );
}
