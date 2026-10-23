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
 * The decisions (verdict, tiles, status, sort) live in lib/ciMetrics.ts.
 *
 * Four tiles above the table filter it; the filter text comes from outside
 * (`filterText`), because the bar at the top of the panel owns the one search
 * box. Without a bar feeding it, a local state stands in so the view still works.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RERUN_DAYS, MIN_SAMPLES, type CheckMetric } from "../../../../shared/checkBaseline.ts";
import { api } from "../../lib/api.ts";
import { usePoll } from "../../lib/usePoll.ts";
import { barScale, barTop, chipCounts, DEFAULT_SORT, rerunWhy, inChip, isSlow, matches, nextSort, sortRows, sparkPaths, span, statusChip, tileOf, TILES, toRow, verdictWords, viewOfTile, type Chip, type CiView, type Row, type Sort, type SortKey, type Tile } from "../../lib/ciMetrics.ts";
import { LINE, RefreshButton } from "../workspace/Chrome.tsx";
import { Chip as StatusChip } from "../git/ui.tsx";
import { Spinner } from "../Spinner.tsx";
import { LENS_REFRESH_CAP } from "../../../../shared/failureVerdict.ts";
import { FailingTestsLens } from "./FailingTestsLens.tsx";
import type { FailingTests } from "../../../../shared/types.ts";

const CHIP_TEXT: Record<Chip, { label: string; title: string }> = {
  all: { label: "All", title: "Every check that has run on this repository" },
  slow: { label: "Slow", title: "The newest run is slower than the check's own slowest 1 in 10" },
  rerun: { label: "Re-run passed", title: `Failed, then passed, on the same commit in the last ${RERUN_DAYS} days, over at least ${MIN_SAMPLES} judged runs. That is the job, not a single test: a check that fails on every commit is broken, not re-run` },
  drifting: { label: "Drifting", title: "The last 7 days took 15% longer than the 7 before" },
};

/** One grid for the header and every row, so the columns cannot drift apart. */
const COLS = "minmax(190px, 1fr) 72px 64px 64px 48px minmax(160px, 380px) 112px";

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
  { key: null, label: "Status", align: "left", title: "One word for what is notable about the newest run" },
];

const TILE_TEXT: Record<Tile, { label: string; title: string }> = {
  all: { label: "All checks", title: CHIP_TEXT.all.title },
  slow: { label: "Slow", title: CHIP_TEXT.slow.title },
  rerun: { label: "Re-run passed", title: CHIP_TEXT.rerun.title },
  attention: { label: "Drifting · failing tests", title: "Checks creeping up week on week, and every failing test the app has read" },
};

const TONE = { bad: "bad", warn: "warn", good: "good" } as const;

function Spark({ r }: { r: Row }) {
  const W = 56, H = 14;
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
  const status = statusChip(r);
  return (
    <div role="row" className="grid items-center gap-x-3 px-3 agx-hover" style={{ gridTemplateColumns: COLS, minHeight: 32, borderTop: QUIET }}>
      <div role="cell" className="flex items-center gap-2 min-w-0">
        <span className="truncate text-[11px]" style={{ color: "var(--text)" }} title={r.workflow ? `${r.workflow} / ${r.name}` : r.name}>{r.name}</span>
        {r.workflow && <span className="text-[10px] truncate" style={{ color: "var(--text3)" }}>{r.workflow}</span>}
        {week != null && <span className="text-[10px] shrink-0 tabular-nums" style={{ color: "var(--text3)" }} title="The last 7 days took longer than the 7 before">▲ {week}%</span>}
      </div>
      <div role="cell"><Spark r={r} /></div>
      <div role="cell" className="text-right text-[11px] tabular-nums" style={{ color: "var(--text)" }}>{r.usual != null ? span(r.usual) : "—"}</div>
      <div role="cell" className="text-right text-[11px] tabular-nums" style={{ color: "var(--text2)" }}>{r.slowEnd != null ? span(r.slowEnd) : "—"}</div>
      <div role="cell" className="text-right text-[11px] tabular-nums" title={rerunWhy(r.sameCommit) || undefined} style={{ color: "var(--text3)" }}>
        {r.failRate != null ? `${Math.round(r.failRate * 100)}%` : "—"}
      </div>
      <div role="cell" className="flex items-center gap-3 min-w-0">
        <Bar r={r} top={top} />
        <span className="text-[11px] tabular-nums shrink-0 w-[52px] text-right" style={{ color: t.ink }}>
          {r.thisRun != null ? span(r.thisRun) : "—"}
        </span>
      </div>
      <div role="cell" className="flex items-center min-w-0">
        {status && <StatusChip tone={TONE[status.tone]} title={r.rerun ? rerunWhy(r.sameCommit) : words || undefined}>{status.label}</StatusChip>}
      </div>
    </div>
  );
}

/** A hairline quieter than the house LINE: forty rows of full-strength rules read as a grid, not a list. */
const QUIET = "1px solid color-mix(in srgb, var(--text) 6%, transparent)";

export function CiMetrics({ root, repo, active, filterText, onFilterText }: {
  root: string; repo: string; active: boolean;
  /** The text the panel's one search box holds. The bar owns the box, so this view draws none; with no bar feeding it a local state stands in. */
  filterText?: string;
  onFilterText?: (v: string) => void;
}) {
  const [checks, setChecks] = useState<CheckMetric[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [chip, setChip] = useState<CiView>("all");
  // The failing tests: read from this server's own record with every poll (no GitHub request), refreshed from GitHub only when asked.
  const [tests, setTests] = useState<FailingTests | null>(null);
  const [testsBusy, setTestsBusy] = useState(false);
  const [testsErr, setTestsErr] = useState("");
  // What the last refresh did stays on the page: the next poll re-reads the table and carries no refresh of its own.
  const [lastRefresh, setLastRefresh] = useState<FailingTests["refresh"]>(undefined);
  const refreshed = useRef(new Set<string>());
  const [localQuery, setLocalQuery] = useState("");
  const query = filterText ?? localQuery;
  const setQuery = onFilterText ?? setLocalQuery;
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
  const loadTests = useCallback(() => {
    if (!root) return;
    api.prFailingTests(root)
      .then((r) => { if ("rows" in r) { setTests(r); setTestsErr(""); } else if (!tests) setTestsErr(r.error || "Could not read the failures"); })
      .catch(() => { if (!tests) setTestsErr("Could not reach the server"); });
  }, [root]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The one thing that reaches GitHub: a few failed runs, newest first. Pressed, or on the first look at the lens. */
  const refreshTests = useCallback(() => {
    if (!root || testsBusy) return;
    setTestsBusy(true);
    api.prFailingTests(root, true)
      .then((r) => { if ("rows" in r) { setTests(r); setLastRefresh(r.refresh); setTestsErr(""); } else setTestsErr(r.error || "Could not read the failures"); })
      .catch(() => setTestsErr("Could not reach the server"))
      .finally(() => setTestsBusy(false));
  }, [root, testsBusy]);
  // Another project starts empty: the last one's checks are not this one's.
  useEffect(() => { setChecks(null); setTests(null); setLastRefresh(undefined); load(); loadTests(); }, [load, loadTests]);
  useEffect(() => {
    if (chip !== "tests" || !tests || refreshed.current.has(root)) return;
    refreshed.current.add(root);
    if (tests.failedRuns > tests.readRuns) refreshTests();
  }, [chip, tests, root, refreshTests]);
  // The runs it reads are recorded whenever a Checks tab loads, so a minute is as fresh as anything upstream of it.
  usePoll(active, () => { load(); loadTests(); }, 60_000);

  const rows = useMemo(() => (checks ?? []).map(toRow), [checks]);
  const found = useMemo(() => rows.filter((r) => matches(r, query)), [rows, query]);
  const counts = useMemo(() => chipCounts(found), [found]);
  const testChip = chip === "tests";
  const shown = useMemo(() => sortRows(found.filter((r) => inChip(testChip ? "all" : chip, r)), sort), [found, chip, testChip, sort]);
  const top = useMemo(() => barTop(rows), [rows]);
  const total = useMemo(() => rows.reduce((n, r) => n + r.runs, 0), [rows]);

  return (
    <div className="flex flex-col gap-3 p-4" role="region" aria-label="CI metrics">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>CI metrics</h2>
        {checks && <span className="text-[11px]" style={{ color: "var(--text3)" }}>{repo} · {total} runs recorded</span>}
        <span className="flex-1" />
        <RefreshButton onRefresh={testChip ? refreshTests : () => { load(); loadTests(); }} busy={testChip ? testsBusy : busy}
          title={testChip ? `Read the failed runs it has not read yet: at most ${LENS_REFRESH_CAP}, newest first, and the cost is stated below` : "Read the recorded runs again"} />
      </div>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }} role="group" aria-label="Which checks">
        {TILES.map((t) => {
          const on = tileOf(chip) === t;
          const n = t === "attention" ? counts.drifting : counts[t];
          const warm = t === "slow" || t === "rerun" ? "var(--warning-ink)" : "var(--text)";
          const frame = { background: on ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "var(--surface-card)", border: LINE, boxShadow: on ? "inset 0 0 0 1px color-mix(in srgb, var(--primary) 45%, transparent)" : undefined } as const;
          return t === "attention" ? (
            <div key={t} className="rounded-xl px-3 py-2 min-w-0" style={frame} title={TILE_TEXT[t].title}>
              <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>{TILE_TEXT[t].label}</div>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <button type="button" aria-pressed={chip === "drifting"} onClick={() => setChip("drifting")} title={CHIP_TEXT.drifting.title}
                  className="agx-btn rounded-md px-1.5 py-0.5 text-[11px] tabular-nums flex items-baseline gap-1"
                  style={{ background: chip === "drifting" ? "color-mix(in srgb, var(--text) 10%, transparent)" : "transparent" }}>
                  <span className="text-[18px] font-semibold leading-none" style={{ color: counts.drifting ? "var(--warning-ink)" : "var(--text3)" }}>{counts.drifting}</span>
                  <span style={{ color: "var(--text2)" }}>Drifting</span>
                </button>
                <button type="button" aria-pressed={testChip} onClick={() => setChip("tests")} title="Every failing test the app has read, counted over runs and pull requests"
                  className="agx-btn rounded-md px-1.5 py-0.5 text-[11px] tabular-nums flex items-baseline gap-1"
                  style={{ background: testChip ? "color-mix(in srgb, var(--text) 10%, transparent)" : "transparent" }}>
                  <span className="text-[18px] font-semibold leading-none" style={{ color: tests?.rows.length ? "var(--error-ink)" : "var(--text3)" }}>{tests ? tests.rows.length : "…"}</span>
                  <span style={{ color: "var(--text2)" }}>Failing tests</span>
                </button>
              </div>
            </div>
          ) : (
            <button key={t} type="button" aria-pressed={on} onClick={() => setChip(viewOfTile(t))} title={TILE_TEXT[t].title}
              className="agx-btn rounded-xl px-3 py-2 text-left min-w-0" style={frame}>
              <div className="text-[10.5px] truncate" style={{ color: "var(--text3)" }}>{TILE_TEXT[t].label}</div>
              <div className="text-[22px] font-semibold leading-tight tabular-nums mt-0.5" style={{ color: n && t !== "all" ? warm : "var(--text)" }}>{n}</div>
            </button>
          );
        })}
      </div>
      {testChip ? (
        <FailingTestsLens data={tests && { ...tests, refresh: lastRefresh }} query={query} busy={testsBusy} error={testsErr} />
      ) : err && !checks ? (
        <div className="text-[11px] px-1 py-6" style={{ color: "var(--text3)" }}>{err}</div>
      ) : !checks ? (
        <div className="flex items-center gap-2 text-[11px] px-1 py-6" style={{ color: "var(--text3)" }}><Spinner /> Reading the recorded runs…</div>
      ) : !rows.length ? (
        <div className="text-[11px] px-1 py-6" style={{ color: "var(--text3)" }}>No runs recorded yet. They are recorded as each pull request's Checks tab loads.</div>
      ) : (
        <div role="table" aria-label="Checks" className="rounded-xl" style={{ background: "var(--surface-card)", border: LINE, boxShadow: "var(--surface-lift)" }}>
          {/* Sticky in the panel's own scroller, so the columns stay named under a long list. No overflow clip on the table itself: it would make the header stick to the table instead. */}
          <div role="row" className="grid items-center gap-x-3 px-3 sticky top-0 z-10 rounded-t-xl" style={{ gridTemplateColumns: COLS, minHeight: 30, background: "var(--surface-inset)", borderBottom: LINE }}>
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
            <div className="text-[11px] px-3 py-6 flex items-center gap-2" style={{ color: "var(--text3)", borderTop: QUIET }}>
              No check matches{query ? <> “{query}”.</> : "."}
              {query && <button type="button" className="agx-btn underline underline-offset-2" style={{ color: "var(--text2)" }} onClick={() => setQuery("")}>Clear the filter</button>}
            </div>
          )}
          <div className="text-[10px] px-3 py-2 flex flex-wrap gap-x-5 gap-y-1" style={{ color: "var(--text3)", borderTop: QUIET }}>
            <span>bar = 0 → usual (solid) → slowest 1 in 10 (faint)</span>
            <span>marker = this run, coloured by its own history</span>
            <span>dashed line = slowest 1 in 10</span>
          </div>
        </div>
      )}
    </div>
  );
}
