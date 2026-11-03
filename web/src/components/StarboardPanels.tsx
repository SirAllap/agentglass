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
import type { StatsSummary, CostByModel, ToolLatencyStat } from "../../../shared/types.ts";
import { subscribeLantern, lanternRows } from "../lib/lanternStore.ts";
import { attention } from "../../../shared/fieldRules.ts";
import type { LanternRow } from "./LanternView.tsx";
import type { AgentCard } from "../lib/derive.ts";
import { tipAttr, type TipSpec } from "../lib/tip.ts";
import { sbTip, type SbTip } from "../lib/starboardTips.ts";
import { crewState, ageWord, baseName, orreryPlan, compareCrew, CREW_WORD, type CrewState } from "../lib/starboardCrew.ts";
import { isScoped, rowMatches, type Scope } from "../lib/starboardScope.ts";
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

export function Crew({ cards, now, scope, onPickSession, onPickWorker }: {
  cards: readonly AgentCard[]; now: number; scope: Scope;
  onPickSession: (session: string) => void; onPickWorker: (worker: string) => void;
}) {
  const rows = useBoard();
  const list = useMemo(() => rows.map((r) => ({ r, ...crewState(r, now) }))
    .sort((a, b) => compareCrew({ ...a, cost: a.r.facts?.cost ?? 0 }, { ...b, cost: b.r.facts?.cost ?? 0 })), [rows, now]);
  const projects = new Set(rows.map((r) => r.project ?? r.worktree ?? "")).size;
  return (
    <Panel area="crew" tip="crew" glyph="crew" title="Crew" meta={`${rows.length} sessions · ${projects} project${projects === 1 ? "" : "s"}`}>
      {list.length === 0 ? <div className="sb-empty">No sessions on the board. Start an agent from the rail.</div> : (
        <div className="sb-crew">
          {list.map(({ r, state, since }) => {
            const age = ageWord(since, now);
            const f = r.facts; const pulse = r.pulse ?? [];
            const peak = Math.max(1, ...pulse); const card = cardOf(r, cards); const ctx = ctxOf(card); const risk = riskChip(card?.risks);
            const picked = (!!r.session && r.session === scope.session) || (!!r.worker && r.name === scope.worker);
            /* A headless worker fires no hooks, so it has no session to scope
               the feed by: its row opens the tab its own reader draws. */
            const pick = r.session ? () => onPickSession(r.session!)
              : r.worker && !r.gone ? () => onPickWorker(r.name) : undefined;
            return (
              <div key={r.name + (r.session ?? "")} className="sb-card" data-st={state} data-sel={picked ? "1" : undefined}
                data-tip={sessionTip(r, state, age)} tabIndex={0} role={pick ? "button" : undefined} aria-pressed={pick ? picked : undefined}
                style={pick ? { cursor: "pointer" } : undefined}
                onClick={pick}
                onKeyDown={pick ? (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } } : undefined}>
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

export function Orrery({ now, working, scope }: { now: number; working: number; scope: Scope }) {
  const rows = useBoard();
  const [ref, { w, h, u }] = useBox();
  const drawn = useMemo(() => rows.filter((r) => !r.gone).slice(0, MAX_BODIES), [rows]);
  const plan = useMemo(() => orreryPlan(drawn, now, w, h, u), [drawn, now, w, h, u]);
  const live = rows.filter((r) => !r.gone).length;
  const hidden = live - drawn.length;
  const finished = rows.length - live;
  const { cx: CX, cy: CY, r: coreR } = plan.core;
  const { nameFs, subFs, ringFs, coreFs, lineGap } = plan;
  return (
    <Panel area="orrery" tip="orrery" glyph="core" title="Orrery" meta={`${plan.bodies.length} sessions${finished ? ` · ${finished} finished not drawn` : ""}${plan.dropped ? ` · ${plan.dropped} ${plan.dropped === 1 ? "name" : "names"} on hover` : ""} · body size = estimated spend`}>
      {rows.length === 0 ? <div className="sb-empty">No sessions on the board. An agent takes an orbit around its project.</div> : (
        <div className="sb-orrery" ref={ref}>
          <svg viewBox={`0 0 ${w} ${h}`} role="group" aria-label="Sessions by project">
            {plan.rings.map(({ project, rx, ry, pill }) => (
              <g key={project}>
                <ellipse className="sb-ring" cx={CX} cy={CY} rx={rx} ry={ry} />
                {pill && <>
                  <rect x={pill.box.x0} y={pill.box.y0} width={pill.w} height={pill.h} rx={9 * u} className="sb-rl" />
                  <text x={pill.lx} y={pill.ly + 4 * u} textAnchor="middle" className="sb-rt" fontSize={ringFs}>{pill.text}</text>
                </>}
              </g>
            ))}
            <circle cx={CX} cy={CY} r={coreR} className="sb-core" />
            {plan.bodies.map(({ row, state, age, x, y, r, label }) => (
              <g key={row.name + (row.session ?? "")} className="sb-body" data-st={state} data-dim={isScoped(scope) && !rowMatches(row, scope) ? "1" : undefined} data-tip={sessionTip(row, state, age)} tabIndex={0} role="img" aria-label={`${row.name}: ${CREW_WORD[state]}`}>
                {state === "working" && <circle className="sb-halo" cx={x} cy={y} r={r} />}
                <circle className="sb-disc" cx={x} cy={y} r={r} />
                {state === "working" && <circle className="sb-spin" cx={x} cy={y} r={r} strokeDasharray={`${(r * 2.6).toFixed(0)} 400`} />}
                {label && <>
                  <text x={label.lx} y={label.ly} textAnchor={label.anchor} className="sb-bn" fontSize={nameFs}>{label.name}</text>
                  {label.sub && <text x={label.lx} y={label.ly + lineGap} textAnchor={label.anchor} className="sb-bs" fontSize={subFs}>{label.sub}</text>}
                </>}
                <circle cx={x} cy={y} r={r + 4} fill="transparent" />
              </g>
            ))}
            {/* The count is painted last: bodies are laid out clear of its box,
                and a body that grazes the edge must never cover the number. */}
            <text x={CX} y={CY - 24 * u} textAnchor="middle" className="sb-core-l" fontSize={coreFs}>{plan.bodies.length} ON BOARD</text>
            <text x={CX} y={CY + 14 * u} textAnchor="middle" className="sb-core-n" style={{ fontSize: 44 * u }}>{working}</text>
            <text x={CX} y={CY + 34 * u} textAnchor="middle" className="sb-core-l" fontSize={coreFs}>WORKING</text>

            {hidden > 0 && <text x={w - 10} y={h - 10} textAnchor="end" className="sb-rt" fontSize={ringFs}>+{hidden} more not drawn</text>}
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
              <div className="sb-nt" data-tip={`${r.name}: ${r.needsYou?.why || (r.needsYou?.kind === "gate" ? "waiting at the gate" : "needs your permission")}`}>{r.name}: {r.needsYou?.why || (r.needsYou?.kind === "gate" ? "waiting at the gate" : "needs your permission")}</div>
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
export function Tools({ stats, latency }: { stats: StatsSummary | null; latency?: ToolLatencyStat[] }) {
  const tl = latency ?? stats?.tool_latency ?? [];
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

export function Cost({ stats, models: scoped }: { stats: StatsSummary | null; models?: CostByModel[] }) {
  const models = scoped ?? (stats?.by_model ?? []).filter((m) => m.cost_usd > 0 || m.input_tokens > 0);
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
