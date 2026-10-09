/*
 * CI metrics: every check of the repository, each judged against its OWN history.
 *
 * The Checks tab answers "is this pull request's job normal" for one run. This
 * is the same question over all of them, so a job that has crept up a quarter
 * in a week, or one that failed and passed on the same commit, shows itself without anybody
 * opening forty pull requests. Never an absolute threshold: an eval suite that
 * always takes 15 minutes is fine at 15 and slow at 40.
 *
 * A table, like the checks list: it scales to dozens of checks and reads the
 * same way. The bar in the last column is the whole idea in one row — dark up
 * to what the job usually takes, light up to its slowest 1 in 10, and a marker
 * for the newest run coloured by what that run is against the job's own past.
 * The decisions (verdict, chips, sort) live in lib/ciMetrics.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FLAKY_DAYS, MIN_SAMPLES, type CheckMetric } from "../../../../shared/checkBaseline.ts";
import { api } from "../../lib/api.ts";
import { usePoll } from "../../lib/usePoll.ts";
import { barScale, barTop, chipCounts, CHIPS, DEFAULT_SORT, flakyWhy, inChip, isSlow, matches, nextSort, sortRows, sparkPaths, span, toRow, verdictWords, type Chip, type Row, type Sort, type SortKey } from "../../lib/ciMetrics.ts";
import { FilterField, LINE, RefreshButton, Segmented } from "../workspace/Chrome.tsx";
import { Spinner } from "../Spinner.tsx";

const CHIP_TEXT: Record<Chip, { label: string; title: string }> = {
  all: { label: "All", title: "Every check that has run on this repository" },
  slow: { label: "Slow", title: "The newest run is slower than the check's own slowest 1 in 10" },
  flaky: { label: "Flaky", title: `Failed and passed on the same commit in the last ${FLAKY_DAYS} days, over at least ${MIN_SAMPLES} judged runs. A check that fails on every commit is broken, not flaky` },
  drifting: { label: "Drifting", title: "The last 7 days took 15% longer than the 7 before" },
};

/** One grid for the header and every row, so the columns cannot drift apart. */
const COLS = "minmax(190px, 1.5fr) 96px 64px 64px 48px minmax(300px, 2fr)";

const TINT = {
  "much-slower": { bar: "var(--error)", ink: "var(--error-ink)" },
  slower: { bar: "var(--warning)", ink: "var(--warning-ink)" },
  usual: { bar: "var(--success)", ink: "var(--success-ink)" },
  faster: { bar: "var(--success)", ink: "var(--success-ink)" },
  unknown: { bar: "var(--text3)", ink: "var(--text3)" },
} as const;

function tintOf(r: Row) {
  return r.failed ? TINT["much-slower"] : TINT[r.verdict];
}

const COLUMNS: { key: SortKey | null; label: string; align: "left" | "right"; title?: string }[] = [
  { key: "check", label: "Check", align: "left" },
  { key: null, label: "14 days", align: "left", title: "One point per day: the median of that day's successful runs" },
  { key: "usual", label: "Usual", align: "right", title: "The median of its successful runs" },
  { key: "slow", label: "Slow end", align: "right", title: "The slowest 1 in 10 of its successful runs" },
  { key: "fails", label: "Fails", align: "right", title: "Failures over successes plus failures; cancelled runs do not count" },
  { key: "verdict", label: "This run against its own history", align: "left", title: "The newest run of the check, judged against that check's own usual" },
];

function Spark({ r }: { r: Row }) {
  const W = 88, H = 14;
  const { lines, last, refY } = useMemo(() => sparkPaths(r.trend, W, H, r.slowEnd), [r.trend, r.slowEnd]);
  const color = isSlow(r) ? "var(--warning-ink)" : "var(--text2)";
  return (
    <svg width={W + 4} height={H + 4} viewBox={`-2 -2 ${W + 4} ${H + 4}`} aria-hidden className="shrink-0">
      {refY != null && <line x1={0} x2={W} y1={refY} y2={refY} stroke="var(--text3)" strokeWidth={0.8} strokeDasharray="2 2" opacity={0.6} />}
      {lines.map((d, i) => <polyline key={i} points={d} fill="none" stroke={color} strokeWidth={1.2} strokeLinejoin="round" strokeLinecap="round" />)}
      {last && <circle cx={last.x} cy={last.y} r={1.8} fill={color} />}
    </svg>
  );
}

function Bar({ r, top }: { r: Row; top: number }) {
  const b = barScale(r, top);
  const t = tintOf(r);
  const pct = (f: number) => `${Math.min(100, f * 100).toFixed(1)}%`;
  return (
    <div className="relative flex-1 min-w-[80px]" style={{ height: 8 }} aria-hidden>
      <div className="absolute inset-0 rounded-full" style={{ background: "color-mix(in srgb, var(--text) 6%, transparent)" }} />
      {r.slowEnd != null && <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: pct(b.slowEnd), background: "color-mix(in srgb, var(--text) 13%, transparent)" }} />}
      {r.usual != null && <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: pct(b.usual), background: "color-mix(in srgb, var(--text) 24%, transparent)" }} />}
      {b.marker != null && <div className="absolute rounded-sm" style={{ left: `calc(${pct(b.marker)} - 1px)`, top: -2, width: 2, height: 12, background: t.bar }} />}
    </div>
  );
}

function Line({ r, top }: { r: Row; top: number }) {
  const t = tintOf(r);
  const words = verdictWords(r);
  const week = r.drift != null ? Math.round(r.drift * 100) : null;
  return (
    <div role="row" className="grid items-center gap-x-3 px-3 agx-hover" style={{ gridTemplateColumns: COLS, minHeight: 34, borderTop: LINE }}>
      <div role="cell" className="flex items-center gap-2 min-w-0">
        <span className="truncate text-[11px]" style={{ color: "var(--text)" }} title={r.workflow ? `${r.workflow} / ${r.name}` : r.name}>{r.name}</span>
        {r.workflow && <span className="text-[10px] shrink-0" style={{ color: "var(--text3)" }}>{r.workflow}</span>}
        {r.flaky && (
          <span className="text-[10px] px-1.5 rounded shrink-0" title={flakyWhy(r.flakiness)}
            style={{ color: "var(--warning-ink)", background: "color-mix(in srgb, var(--warning) 16%, transparent)" }}>
            Flaky
          </span>
        )}
        {week != null && (
          <span className="text-[10px] px-1.5 rounded shrink-0" title="The last 7 days took longer than the 7 before"
            style={{ color: "var(--warning-ink)", background: "color-mix(in srgb, var(--warning) 16%, transparent)" }}>
            ▲ {week}% this week
          </span>
        )}
      </div>
      <div role="cell"><Spark r={r} /></div>
      <div role="cell" className="text-right text-[11px] tabular-nums" style={{ color: "var(--text)" }}>{r.usual != null ? span(r.usual) : "—"}</div>
      <div role="cell" className="text-right text-[11px] tabular-nums" style={{ color: "var(--text2)" }}>{r.slowEnd != null ? span(r.slowEnd) : "—"}</div>
      <div role="cell" className="text-right text-[11px] tabular-nums" title={flakyWhy(r.flakiness) || undefined} style={{ color: "var(--text3)" }}>
        {r.failRate != null ? `${Math.round(r.failRate * 100)}%` : "—"}
      </div>
      <div role="cell" className="flex items-center gap-3 min-w-0">
        <Bar r={r} top={top} />
        <span className="text-[11px] tabular-nums shrink-0" style={{ color: t.ink, width: 148 }}>
          {r.thisRun != null ? span(r.thisRun) : "—"}{words && ` · ${words}`}
        </span>
      </div>
    </div>
  );
}

export function CiMetrics({ root, repo, active }: { root: string; repo: string; active: boolean }) {
  const [checks, setChecks] = useState<CheckMetric[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [chip, setChip] = useState<Chip>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);

  // The newest request wins: an answer for the project the panel has since left must not be drawn under the new one's name.
  const asked = useRef(0);
  const load = useCallback(() => {
    if (!root) return;
    const mine = ++asked.current;
    setBusy(true);
    api.prCheckMetrics(root)
      // The poll answers the same thing most minutes: keep the old array so no row is drawn again for nothing.
      .then((r) => { if (mine !== asked.current) return; if (r.ok) { const next = r.checks ?? []; setChecks((cur) => (cur && JSON.stringify(cur) === JSON.stringify(next) ? cur : next)); setErr(""); } else setErr(r.error || "No metrics"); })
      .catch(() => { if (mine === asked.current) setErr("Could not reach the server"); })
      .finally(() => { if (mine === asked.current) setBusy(false); });
  }, [root]);
  // Another project starts empty: the last one's checks are not this one's.
  useEffect(() => { setChecks(null); load(); }, [load]);
  // The runs it reads are recorded whenever a Checks tab loads, so a minute is as fresh as anything upstream of it.
  usePoll(active, load, 60_000);

  const rows = useMemo(() => (checks ?? []).map(toRow), [checks]);
  const found = useMemo(() => rows.filter((r) => matches(r, query)), [rows, query]);
  const counts = useMemo(() => chipCounts(found), [found]);
  const shown = useMemo(() => sortRows(found.filter((r) => inChip(chip, r)), sort), [found, chip, sort]);
  const top = useMemo(() => barTop(rows), [rows]);
  const total = useMemo(() => rows.reduce((n, r) => n + r.runs, 0), [rows]);

  return (
    <div className="flex flex-col gap-3 p-4" role="region" aria-label="CI metrics">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>CI metrics</h2>
        {checks && <span className="text-[11px]" style={{ color: "var(--text3)" }}>{repo} · {total} runs recorded</span>}
        <span className="flex-1" />
        <RefreshButton onRefresh={load} busy={busy} title="Read the recorded runs again" />
      </div>
      <div className="flex items-center gap-3">
        <Segmented<Chip> label="Which checks" value={chip} onChange={setChip}
          options={CHIPS.map((c) => ({ id: c, title: CHIP_TEXT[c].title, label: <>{CHIP_TEXT[c].label} <span className="tabular-nums" style={{ opacity: 0.7 }}>{counts[c]}</span></> }))} />
        <span className="flex-1" />
        <FilterField value={query} onChange={setQuery} placeholder="Filter checks…" label="Filter checks" className="w-[220px]" />
      </div>
      {err && !checks ? (
        <div className="text-[11px] px-1 py-6" style={{ color: "var(--text3)" }}>{err}</div>
      ) : !checks ? (
        <div className="flex items-center gap-2 text-[11px] px-1 py-6" style={{ color: "var(--text3)" }}><Spinner /> Reading the recorded runs…</div>
      ) : !rows.length ? (
        <div className="text-[11px] px-1 py-6" style={{ color: "var(--text3)" }}>No runs recorded yet. They are recorded as each pull request's Checks tab loads.</div>
      ) : (
        <div role="table" aria-label="Checks" className="rounded-xl overflow-hidden" style={{ background: "var(--surface-card)", border: LINE, boxShadow: "var(--surface-lift)" }}>
          <div role="row" className="grid items-center gap-x-3 px-3" style={{ gridTemplateColumns: COLS, minHeight: 30, background: "var(--surface-inset)" }}>
            {COLUMNS.map((c) => c.key ? (
              <button key={c.label} role="columnheader" type="button" title={c.title} onClick={() => setSort(nextSort(sort, c.key!))}
                aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                className="agx-btn text-[10px] flex items-center gap-1 min-w-0"
                style={{ justifyContent: c.align === "right" ? "flex-end" : "flex-start", color: sort.key === c.key ? "var(--text)" : "var(--text3)", fontWeight: sort.key === c.key ? 600 : 400 }}>
                <span className="truncate">{c.label}</span>
                {sort.key === c.key && <span aria-hidden>{sort.dir === "asc" ? "▲" : "▼"}</span>}
              </button>
            ) : (
              <div key={c.label} role="columnheader" title={c.title} className="text-[10px]" style={{ color: "var(--text3)" }}>{c.label}</div>
            ))}
          </div>
          {shown.length ? shown.map((r) => <Line key={r.key} r={r} top={top} />) : (
            <div className="text-[11px] px-3 py-6" style={{ color: "var(--text3)", borderTop: LINE }}>No check matches.</div>
          )}
          <div className="text-[10px] px-3 py-2 flex flex-wrap gap-x-5 gap-y-1" style={{ color: "var(--text3)", borderTop: LINE }}>
            <span>bar = 0 → usual (solid) → slowest 1 in 10 (faint)</span>
            <span>marker = this run, coloured by its own history</span>
            <span>dashed line = slowest 1 in 10</span>
          </div>
        </div>
      )}
    </div>
  );
}
