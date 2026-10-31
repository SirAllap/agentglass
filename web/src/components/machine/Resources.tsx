// What the machine is doing and what you can free: five dials, what an agent left
// behind, the disk plan, and the process tree down to a pid.
//
// Nothing here runs on a clock. The host's CPU, load and temperature have no
// event source, so they are read on open, on window focus and on Refresh, and
// once more a moment after the first reading (a rate needs two samples). While
// Docker's stats feed is streaming, each sample may ask for a new reading, at
// most one per RESAMPLE_GAP_MS (see resampleDue); with no feed that stops.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import type { GitRepoRef, ResourceReport } from "../../../../shared/types.ts";
import { CaretIcon } from "../../lib/glyphIcons.tsx";
import { RING, dialSub, dialsOf, mb, pushSample, resampleDue, ringDash, sparkPoints, treeOf, type Dial } from "../../lib/machineView.ts";
import { publishMachineDisk } from "../../lib/diskClean.ts";
import { useDockerLive } from "../../lib/useDockerLive.ts";
import { useRefreshOnFocus } from "../../lib/useRefreshOnFocus.ts";
import { FilterField, RefreshButton } from "../workspace/Chrome.tsx";
import { DiskClean } from "../DiskClean.tsx";
import { DetailPane } from "./DetailPane.tsx";
import { LeftBehind } from "./LeftBehind.tsx";
import { Space } from "./Space.tsx";
import { Pad } from "./bits.tsx";

/** Between two readings asked for by the stats feed. */
const RESAMPLE_GAP_MS = 5000;
/** The first reading has no rate; one more look, a moment later, gives it. */
const SECOND_SAMPLE_MS = 1500;

function DialCard({ d }: { d: Dial }) {
  const dash = ringDash(d.pct);
  return (
    <div className="mc-gz" data-hot={d.hot || undefined}>
      <svg viewBox="0 0 40 40" aria-hidden>
        <circle cx="20" cy="20" r={RING.r} fill="none" stroke="var(--bg3)" strokeWidth="4" />
        {dash && <circle cx="20" cy="20" r={RING.r} fill="none" stroke={d.hot ? "var(--warning)" : "var(--info)"} strokeWidth="4" strokeLinecap="round" strokeDasharray={dash} transform="rotate(-90 20 20)" />}
      </svg>
      <div style={{ minWidth: 0 }}>
        <div className="k">{d.label}</div><div className="v">{d.value}</div>
        <div className="s" title={d.hot && d.word ? `${d.sub} · ${d.word}` : d.sub}>{dialSub(d)}</div>
      </div>
    </div>
  );
}

function TreeRow({ kind, label, cpu, rss, spark, caret, shut, onClick, selected, aside, title, dot }: {
  kind: "proj" | "chk" | "prc" | "rest"; label: string; cpu: number | null; rss: number; spark?: number[]; caret?: boolean; shut?: boolean;
  onClick?: () => void; selected?: boolean; aside?: string; title?: string; dot?: boolean;
}) {
  const El = onClick ? "button" : "div";
  return (
    <El {...(onClick ? { type: "button" as const, onClick } : {})} className="mc-trow" data-k={kind} data-sel={selected || undefined} title={title}>
      <span className="tl">
        {caret && <i className="mc-car" data-shut={shut || undefined}><CaretIcon size={12} /></i>}
        {dot && <i className="mc-gd" />}
        <span className="tn">{label}</span>{aside && <small>{aside}</small>}
      </span>
      <span className="mc-spark">{spark && spark.length > 2 && (
        <svg width="60" height="14" aria-hidden><polyline points={sparkPoints(spark)} fill="none" stroke={cpu != null && cpu >= 80 ? "var(--warning)" : "var(--success)"} strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" /></svg>
      )}</span>
      <span className={`r${cpu != null && cpu >= 80 ? " hot" : ""}`}>{cpu == null ? "—" : `${cpu.toFixed(1)}%`}</span>
      <span className="r">{mb(rss)}</span>
    </El>
  );
}

export function Resources() {
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [data, setData] = useState<ResourceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [tick, setTick] = useState(0);
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  /** CPU over time per group key. A ref: written on every reading and read by the render that reading caused. */
  const history = useRef<Map<string, number[]>>(new Map());
  const inFlight = useRef(false);
  const lastAt = useRef(0);
  const secondLooks = useRef(0);

  const load = useCallback(() => {
    inFlight.current = true; lastAt.current = Date.now(); setLooking(true);
    api.machineResources()
      .then((d) => {
        setData(d); setError(null);
        publishMachineDisk(d.machine);
      })
      .catch((e) => setError(String(e)))
      .finally(() => { inFlight.current = false; setLooking(false); });
  }, []);
  const loadRepos = useCallback(() => { api.gitRepos().then(({ repos: r }) => setRepos(r)).catch(() => {}); }, []);
  const refresh = () => { secondLooks.current = 0; setTick((t) => t + 1); load(); loadRepos(); };

  useEffect(() => { load(); loadRepos(); }, [load, loadRepos]);
  useRefreshOnFocus(true, load);
  useDockerLive(true, {
    onStats: () => { if (resampleDue(Date.now(), lastAt.current, RESAMPLE_GAP_MS, inFlight.current)) load(); },
    onChanged: (scope) => { if (scope === "containers") load(); },
    onReconnect: load,
  });
  // A rate needs two readings: one more look after the first, then nothing until the person or the feed asks.
  useEffect(() => {
    if (!data || data.rated || secondLooks.current >= 2) return;
    secondLooks.current++;
    const t = setTimeout(load, SECOND_SAMPLE_MS);
    return () => clearTimeout(t);
  }, [data, load]);

  const tree = useMemo(() => treeOf(data?.procs ?? [], repos, q), [data, repos, q]);
  // Record this reading against every key on screen, so a line that appears later starts empty.
  // A project and its main checkout share one path, so the project's line gets its own key: one key was one history fed twice per reading and one caret that closed both.
  const projKey = (key: string) => `project:${key}`;
  if (data?.rated) for (const n of tree) { pushSample(history.current, projKey(n.key), n.cpu); for (const k of n.kids) pushSample(history.current, k.key, k.cpu); }

  if (error && !data) return <Pad error onRetry={load}>{error}</Pad>;
  if (!data) return <Pad>Reading /proc…</Pad>;

  const otherRss = Math.max(0, data.totalRss - data.oursRss);
  const otherCpu = data.totalCpu != null && data.oursCpu != null ? Math.max(0, data.totalCpu - data.oursCpu) : null;
  const live = (data.procs ?? []).filter((p) => p.ours).length;
  const dials = dialsOf(data.machine);
  const flip = (key: string, set: typeof setShut) => set((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  return (
    <div className="mc-body">
      <div className="mc-main">
        <div className="mc-tool">
          <div className="mc-fld"><FilterField value={q} onChange={setQ} placeholder="Filter by process, command, checkout or pid…" label="Filter processes" /></div>
          <div className="mc-ours">
            <b>{data.oursCpu != null ? data.oursCpu.toFixed(1) : "—"}<small>%</small></b>
            <b>{(data.oursRss / 1024 ** 3).toFixed(2)}<small> GB</small></b>
            <span>Σ RSS · {live} process{live === 1 ? "" : "es"} of ours{!data.rated && " · CPU needs a second sample"}</span>
          </div>
          <RefreshButton onRefresh={refresh} spinning={looking} title="Sample again now" />
        </div>
        <div className="mc-scr mc-res" style={{ flex: 1 }}>
          {dials.length > 0 && <div className="mc-gauges" role="group" aria-label="This machine">{dials.map((d) => <DialCard key={d.key} d={d} />)}</div>}
          <div className="mc-rcols">
            <div className="mc-rcol">
              <LeftBehind tick={tick} />
              <DiskClean />
            </div>
            <div className="mc-rcol">
              <section aria-label="Processes">
                <div className="mc-trow" data-k="hd"><span>Name</span><span /><span className="r">CPU</span><span className="r">RSS</span></div>
                {tree.length === 0 && <div className="mc-empty">Nothing of ours is running.</div>}
                {tree.map((n) => {
                  const closed = shut.has(projKey(n.key));
                  return (
                    <div key={n.key}>
                      <TreeRow kind="proj" label={n.label} cpu={data.rated ? n.cpu : null} rss={n.rss} title={n.key} caret shut={closed} spark={history.current.get(projKey(n.key))} onClick={() => flip(projKey(n.key), setShut)} />
                      {!closed && n.kids.map((k) => {
                        const kShut = shut.has(k.key);
                        const procs = showAll.has(k.key) ? k.procs : k.procs.slice(0, 8);
                        return (
                          <div key={k.key}>
                            <TreeRow kind="chk" label={k.label} cpu={data.rated ? k.cpu : null} rss={k.rss} title={k.key} caret shut={kShut} spark={history.current.get(k.key)} onClick={() => flip(k.key, setShut)} />
                            {!kShut && procs.map((p) => (
                              <TreeRow key={p.pid} kind="prc" dot label={p.comm} cpu={p.cpu} rss={p.rss} aside={`pid ${p.pid}`} title={`${p.cmd || p.comm}\npid ${p.pid}\n${p.cwd ?? ""}`}
                                selected={selected === p.pid} onClick={() => setSelected((s) => (s === p.pid ? null : p.pid))} />
                            ))}
                            {!kShut && k.procs.length > procs.length && (
                              <button type="button" className="mc-trow" data-k="more" onClick={() => setShowAll((c) => new Set(c).add(k.key))}>
                                show {k.procs.length - procs.length} more in this checkout
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {/* One line, not four hundred: how much of the machine the rest leaves is the only thing worth knowing about it. */}
                <TreeRow kind="rest" label="The rest of this machine" cpu={otherCpu} rss={otherRss} aside={`${data.seen} processes seen`} />
              </section>
            </div>
          </div>
        </div>
        <Space repos={repos} />
      </div>
      {selected != null && <DetailPane pid={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
