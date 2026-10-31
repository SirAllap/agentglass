// The five Starboard panels that read the board and the stats: Crew, Orrery,
// Needs you, Tools and Cost. They replace Fleet, Radar, ToolMix, Latency and
// CostByModel, which counted the same things by four different rules.
//
// Sessions come from the Lantern's rows (the rows the KPI strip counts), so a
// card and a number cannot disagree. Motion
// belongs to "in progress" only (a spinning arc, a halo) and is switched off
// under prefers-reduced-motion in index.css.
import { useSyncExternalStore, useMemo, useRef, useState, useLayoutEffect } from "react";
import type { ReactNode } from "react";
import type { StatsSummary } from "../../../shared/types.ts";
import { subscribeLantern, lanternRows } from "../lib/lanternStore.ts";
import { attention } from "../../../shared/fieldRules.ts";
import type { LanternRow } from "./LanternView.tsx";
import type { AgentCard } from "../lib/derive.ts";
import { tipAttr, type TipSpec } from "../lib/tip.ts";
import { sbTip, type SbTip } from "../lib/starboardTips.ts";
import { crewState, ageWord, baseName, orreryLayout, RINGS, CREW_ORDER, CREW_WORD, type CrewState } from "../lib/starboardCrew.ts";
import { SbGlyphIcon, type SbGlyph } from "../lib/starboardGlyphs.tsx";
import { fmtUsd, fmtMs, modelLabelOf, modelColor } from "../lib/format.ts";
import { Button } from "./workspace/Chrome.tsx";
import { riskChip, riskTitle } from "../lib/riskView.ts";

/** The board's rows without the Lantern's own session, which is never counted. */
export function useBoard(): LanternRow[] {
  const all = useSyncExternalStore(subscribeLantern, lanternRows, lanternRows);
  return useMemo(() => (all ?? []).filter((r) => r.role !== "lantern"), [all]);
}

/** How many sessions are in each state: the header chips read it, so a chip and a card cannot disagree. */
export function useCrewCounts(now: number): Record<CrewState, number> {
  const rows = useBoard();
  return useMemo(() => {
    const n: Record<CrewState, number> = { ask: 0, working: 0, quiet: 0, done: 0 };
    for (const r of rows) n[crewState(r, now).state]++;
    return n;
  }, [rows, now]);
}

export function Panel({ area, tip, glyph, title, meta, mark = "m", children }: {
  area?: string; tip: SbTip; glyph: SbGlyph; title: string; meta: ReactNode; mark?: "m" | "e"; children: ReactNode;
}) {
  return (
    <section className="sb-panel" data-area={area} aria-label={title}>
      <div className="sb-ph" data-tip={sbTip(tip)} tabIndex={0}>
        <span className="sb-glyph"><SbGlyphIcon g={glyph} /></span>
        <h2>{title}</h2>
        <i className="sb-tm" data-m={mark} />
        <span className="sb-sp" /><span className="sb-meta">{meta}</span>
      </div>
      <div className="sb-pb">{children}</div>
    </section>
  );
}

const sessionTip = (r: LanternRow, st: CrewState, since: string): string => tipAttr({
  name: r.name, mono: true, tag: CREW_WORD[st], trust: "measured",
  from: "The Lantern board and this session's hook events.",
  how: st === "ask" ? `Stopped on ${r.needsYou?.kind ?? "a question"}: ${r.needsYou?.why ?? "waiting for you"}.`
    : st === "done" ? "Its last turn ended or its pane is gone."
    : st === "quiet" ? `No sign of life for ${since}.` : `Last activity ${since} ago.`,
  caveat: "Tools, errors and cost are the session's lifetime. Cost is estimated. Quiet is an age, not a verdict.",
} satisfies TipSpec);

const DOT: Record<CrewState, string> = { working: "ok", ask: "warn", quiet: "off", done: "off" };

/** The hook-derived card of the same session: it holds what the board does not (context, review flags). */
const cardOf = (r: LanternRow, cards: readonly AgentCard[]) => cards.find((a) => a.session_id === r.session);
const ctxOf = (c: AgentCard | undefined): number => (c && c.ctxLimit > 0 ? Math.min(1, c.ctxTokens / c.ctxLimit) : 0);

export function Crew({ cards, now }: { cards: readonly AgentCard[]; now: number }) {
  const rows = useBoard();
  const list = useMemo(() => rows.map((r) => ({ r, ...crewState(r, now) }))
    .sort((a, b) => CREW_ORDER[a.state] - CREW_ORDER[b.state] || (b.r.facts?.cost ?? 0) - (a.r.facts?.cost ?? 0)), [rows, now]);
  const projects = new Set(rows.map((r) => r.project ?? r.worktree ?? "")).size;
  return (
    <Panel area="crew" tip="crew" glyph="crew" title="Crew" meta={`${rows.length} sessions · ${projects} project${projects === 1 ? "" : "s"}`}>
      {list.length === 0 ? <div className="sb-empty">No sessions on the board. Start an agent from the rail.</div> : (
        <div className="sb-crew">
          {list.map(({ r, state, since }) => {
            const age = ageWord(since, now);
            const f = r.facts; const pulse = r.pulse ?? [];
            const peak = Math.max(1, ...pulse); const card = cardOf(r, cards); const ctx = ctxOf(card); const risk = riskChip(card?.risks);
            return (
              <div key={r.name + (r.session ?? "")} className="sb-card" data-st={state} data-tip={sessionTip(r, state, age)} tabIndex={0}>
                <div className="sb-r1">
                  <i className="sb-dot" data-s={DOT[state]} data-ring={state === "quiet" ? "1" : undefined} />
                  <span className="sb-nm" data-tip={r.name}>{r.name}</span>
                  {(r.project ?? r.worktree) && <span className="sb-pill" data-tip={r.project ?? r.worktree}>{baseName((r.project ?? r.worktree)!)}</span>}
                  {f?.model && <span className="sb-pill" data-k="model" data-tip={f.model}>{modelLabelOf(f.model)}</span>}
                  {risk && <span className="sb-pill" style={{ color: risk.tone }} data-tip={`Review first:\n${riskTitle(card!.risks)}`}>{risk.text}</span>}
                  <span className="sb-age">{state === "ask" ? `waiting ${age}` : state === "done" ? `ended ${age} ago` : state === "quiet" ? `quiet ${age}` : `${age} ago`}</span>
                </div>
                <div className="sb-doing" data-tip={state === "ask" ? r.needsYou?.why || "waiting for you" : r.doing ?? undefined}>{state === "ask" ? r.needsYou?.why || "waiting for you" : r.doing ?? "no status line"}</div>
                <div className="sb-r3">
                  <span><b>{f?.tools ?? 0}</b> tools</span>
                  <span data-bad={f?.errors ? "1" : undefined}><b>{f?.errors ?? 0}</b> err</span>
                  <span><b>~{fmtUsd(f?.cost ?? 0)}</b></span>
                  <span className="sb-mini" aria-hidden>{pulse.map((v, i) => <i key={i} style={{ height: `${Math.max(8, (v / peak) * 100)}%` }} />)}</span>
                </div>
                {ctx > 0 && <div className="sb-ctx" data-hot={ctx > 0.8 ? "1" : undefined} data-tip={`${Math.round(ctx * 100)}% of the context window`}><i style={{ width: `${ctx * 100}%` }} /></div>}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

const MAX_BODIES = 28;

/** The pixel size of the panel body and the view's text scale (--sb-u), so the
 *  orbits fill the panel at every width and the labels read at the view's size. */
function useBox(): [React.RefObject<HTMLDivElement>, { w: number; h: number; u: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 1000, h: 800, u: 1 });
  useLayoutEffect(() => {
    const el = ref.current; if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => setBox({ w: Math.max(300, el.clientWidth), h: Math.max(240, el.clientHeight), u: (parseFloat(getComputedStyle(el).fontSize) || 10.4) / 13 });
    read(); const ro = new ResizeObserver(read); ro.observe(el); return () => ro.disconnect();
  }, []);
  return [ref, box];
}

/** The angle on a ring (upper half) farthest from every body on it, so the ring's
 *  name label does not sit on a session. */
function labelAngle(angles: number[]): number {
  let best = -90, gap = -1;
  for (let c = -150; c <= -30; c += 6) {
    const d = Math.min(360, ...angles.map((a) => Math.abs((((a - c) % 360) + 540) % 360 - 180)));
    if (d > gap) { gap = d; best = c; }
  }
  return best;
}

const doingOf = (row: LanternRow, st: CrewState, age: string): string =>
  st === "ask" ? row.needsYou?.why || "waiting for you" : st === "done" ? `finished ${age} ago` : st === "quiet" ? `quiet ${age}` : row.doing ?? "no status line";
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

export function Orrery({ now, working }: { now: number; working: number }) {
  const rows = useBoard();
  const [ref, { w, h, u }] = useBox();
  const { placed, projects, projectCount } = useMemo(() => orreryLayout(rows.filter((r) => !r.gone).slice(0, MAX_BODIES)), [rows]);
  const live = rows.filter((r) => !r.gone).length;
  const hidden = live - placed.length;
  const finished = rows.length - live;
  const ringName = (p: string, i: number) => (i === RINGS - 1 && projectCount > RINGS ? `${projectCount - RINGS + 1} other projects` : clip(baseName(p), 18));
  const CX = w / 2, CY = h / 2, RXM = Math.max(80, w / 2 - 190 * u), RYM = Math.max(70, h / 2 - 50 * u);
  const frac = (i: number) => (projects.length === 1 ? 0.7 : 0.34 + (0.66 * i) / (projects.length - 1));
  return (
    <Panel area="orrery" tip="orrery" glyph="core" title="Orrery" meta={`${placed.length} sessions${finished ? ` · ${finished} finished not drawn` : ""} · body size = estimated spend`}>
      {rows.length === 0 ? <div className="sb-empty">No sessions on the board. An agent takes an orbit around its project.</div> : (
        <div className="sb-orrery" ref={ref}>
          <svg viewBox={`0 0 ${w} ${h}`} role="group" aria-label="Sessions by project">
            {projects.map((p, i) => {
              const la = (labelAngle(placed.filter((q) => q.ring === i).map((q) => q.angle)) * Math.PI) / 180;
              const lx = CX + Math.cos(la) * RXM * frac(i), ly = CY + Math.sin(la) * RYM * frac(i);
              return (
                <g key={p}>
                  <ellipse className="sb-ring" cx={CX} cy={CY} rx={RXM * frac(i)} ry={RYM * frac(i)} />
                  <rect x={lx - 60 * u} y={ly - 9 * u} width={120 * u} height={18 * u} rx={9 * u} className="sb-rl" />
                  <text x={lx} y={ly + 4 * u} textAnchor="middle" className="sb-rt" fontSize={11 * u}>{ringName(p, i)}</text>
                </g>
              );
            })}
            <circle cx={CX} cy={CY} r={66 * u} className="sb-core" />
            <text x={CX} y={CY - 24 * u} textAnchor="middle" className="sb-core-l" fontSize={9.5 * u}>{placed.length} ON BOARD</text>
            <text x={CX} y={CY + 14 * u} textAnchor="middle" className="sb-core-n" style={{ fontSize: 44 * u }}>{working}</text>
            <text x={CX} y={CY + 34 * u} textAnchor="middle" className="sb-core-l" fontSize={10.5 * u}>WORKING</text>
            {placed.map(({ row, ring, angle }) => {
              const { state, since } = crewState(row, now);
              const age = ageWord(since, now);
              const a = (angle * Math.PI) / 180; const x = CX + Math.cos(a) * RXM * frac(ring); const y = CY + Math.sin(a) * RYM * frac(ring);
              const r = (12 + Math.sqrt(Math.max(0, row.facts?.cost ?? 0)) * 3.1) * u;
              const right = Math.cos(a) >= -0.1; const lx = right ? x + r + 8 * u : x - r - 8 * u;
              return (
                <g key={row.name + (row.session ?? "")} className="sb-body" data-st={state} data-tip={sessionTip(row, state, age)} tabIndex={0} role="img" aria-label={`${row.name}: ${CREW_WORD[state]}`}>
                  {state === "working" && <circle className="sb-halo" cx={x} cy={y} r={r} />}
                  <circle className="sb-disc" cx={x} cy={y} r={r} />
                  {state === "working" && <circle className="sb-spin" cx={x} cy={y} r={r} strokeDasharray={`${(r * 2.6).toFixed(0)} 400`} />}
                  <text x={lx} y={y} textAnchor={right ? "start" : "end"} className="sb-bn" fontSize={13.5 * u}>{clip(row.name, 20)}</text>
                  <text x={lx} y={y + 14 * u} textAnchor={right ? "start" : "end"} className="sb-bs" fontSize={10.5 * u}>{clip(doingOf(row, state, age), 26)}</text>
                  <circle cx={x} cy={y} r={r + 4} fill="transparent" />
                </g>
              );
            })}
            {hidden > 0 && <text x={w - 10} y={h - 10} textAnchor="end" className="sb-rt" fontSize={11 * u}>+{hidden} more not drawn</text>}
          </svg>
        </div>
      )}
    </Panel>
  );
}

export function NeedsYou({ onOpenLantern, now }: { onOpenLantern: () => void; now: number }) {
  const rows = useBoard().filter((r) => attention(r, now) === "blocked");
  return (
    <Panel tip="needs" glyph="needs" title="Needs you" meta={`${rows.length} waiting`}>
      {rows.length === 0 ? <div className="sb-empty">Nothing is waiting on you.</div> : (
        <div className="sb-needs">
          {rows.map((r) => (
            <div key={r.name + (r.session ?? "")} className="sb-need">
              <div className="sb-nt" data-tip={`${r.name}: ${r.needsYou?.why || (r.needsYou?.kind === "gate" ? "held at the gate" : "needs your permission")}`}>{r.name}: {r.needsYou?.why || (r.needsYou?.kind === "gate" ? "held at the gate" : "needs your permission")}</div>
              <div className="sb-ns">{baseName(r.project ?? r.worktree ?? "no project")} · waiting {ageWord(r.needsYou?.since ?? now, now)}</div>
              <Button size="compact" onClick={onOpenLantern}>Open</Button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

const MIX_TOP = 6;
export function Tools({ stats }: { stats: StatsSummary | null }) {
  const tl = stats?.tool_latency ?? [];
  const total = tl.reduce((s, t) => s + t.calls, 0);
  const top = tl.slice(0, MIX_TOP);
  const rest = tl.slice(MIX_TOP).reduce((s, t) => s + t.calls, 0);
  const shade = (i: number) => `color-mix(in srgb, var(--text) ${Math.max(18, 78 - i * 12)}%, var(--bg))`;
  const slices = [...top.map((t, i) => ({ k: t.tool_name, n: t.calls, c: i === 0 ? "var(--primary)" : shade(i) })), ...(rest ? [{ k: "Other", n: rest, c: "color-mix(in srgb, var(--text4) 55%, transparent)" }] : [])];
  const timed = top.filter((t) => t.timed !== 0).slice(0, 5);
  const max = Math.max(1, ...timed.map((t) => t.p95_ms));
  return (
    <Panel tip="tools_panel" glyph="tools" title="Tools" meta={`${total.toLocaleString()} calls`}>
      {total === 0 ? <div className="sb-empty">No tool calls in this window.</div> : (
        <div className="sb-tools">
          <div className="sb-wcn">What the fleet is doing, by calls in the window</div>
          <div className="sb-mixbar" role="img" aria-label="Tool mix">{slices.map((s) => <i key={s.k} style={{ width: `${(s.n / total) * 100}%`, background: s.c }} />)}</div>
          <div className="sb-legend">{slices.map((s) => <span key={s.k}><i style={{ background: s.c }} />{s.k} {Math.round((s.n / total) * 100)}%</span>)}</div>
          <div className="sb-wcn">Wall-clock median / slowest 1 in 20 · includes waiting on you</div>
          {timed.map((t) => (
            <div key={t.tool_name} className="sb-wc">
              <span className="sb-wn">{t.tool_name}</span>
              <span className="sb-tr"><i style={{ width: `${(t.p50_ms / max) * 100}%` }} /><b style={{ left: `${(t.p95_ms / max) * 100}%` }} /></span>
              <span className="sb-wv"><em>{fmtMs(t.p50_ms)}</em> / {fmtMs(t.p95_ms)}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function Cost({ stats }: { stats: StatsSummary | null }) {
  const models = (stats?.by_model ?? []).filter((m) => m.cost_usd > 0 || m.input_tokens > 0);
  const total = models.reduce((s, m) => s + m.cost_usd, 0);
  const C = 2 * Math.PI * 38; let off = 0;
  return (
    <Panel tip="cost" glyph="cost" title="Cost" meta="estimated" mark="e">
      {models.length === 0 ? <div className="sb-empty">No token usage in this window.</div> : (
        <div className="sb-cost">
          <svg viewBox="0 0 100 100" role="img" aria-label="Estimated spend by model">
            {models.map((m) => {
              const len = total > 0 ? (m.cost_usd / total) * C : 0; const el = (
                <circle key={m.model_name} cx="50" cy="50" r="38" fill="none" stroke={modelColor(m.model_name)} strokeWidth="12" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} transform="rotate(-90 50 50)" />
              ); off += len; return el;
            })}
            <text x="50" y="49" textAnchor="middle" className="sb-donut-n">~{fmtUsd(total)}</text>
            <text x="50" y="60" textAnchor="middle" className="sb-donut-l">est. total</text>
          </svg>
          <div className="sb-costrows">
            {models.map((m) => (
              <div key={m.model_name}>
                <i style={{ background: modelColor(m.model_name) }} /><span>{m.model_name}{m.unpriced && <u title="No rate for this model: a fallback price is used where the provider reported none.">~</u>}</span>
                <b>~{fmtUsd(m.cost_usd)}</b><small>{total > 0 ? Math.round((m.cost_usd / total) * 100) : 0}%</small>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
