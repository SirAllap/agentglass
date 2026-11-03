/*
 * CI metrics: every check of the repository, each judged against its OWN history.
 *
 * The Checks tab answers "is this pull request's job normal" for one run. This
 * is the same question over all of them, so a job that has crept up a quarter
 * in a week, or one that failed and passed on the same commit, shows itself without anybody
 * opening forty pull requests. Never an absolute threshold: an eval suite that
 * always takes 15 minutes is fine at 15 and slow at 40.
 *
 * A list of rows, as the mockup draws it: the check, a bar per day, what it
 * usually takes and the share of its runs that passed. Every other fact the old
 * table had in columns (slow end, fails, the bar of this run against its own
 * history, the status word, the dashed slowest-1-in-10 line) is in the row when
 * it is opened, so the list stays a list and nothing is gone. The bar of an
 * opened row is the whole idea in one picture — dark up to what the job usually
 * takes, light up to its slowest 1 in 10, and a marker for the newest run
 * coloured by what that run is against the job's own past. The decisions
 * (verdict, tiles, status, sort) live in lib/ciMetrics.ts.
 *
 * Five tiles above the history filter it (Pass rate, Median run, Re-run
 * passed, Drifting, Failing now); under it, always on the page, are the failing
 * tests. The history has a filter and a sort of its own in its header, and the
 * failing tests a filter of theirs: the bar at the top of the panel keeps the
 * one global search, as the mockup draws it, and typing in it from here goes to
 * the board's search (the panel does that, not this view).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { RERUN_DAYS, MIN_SAMPLES, type CheckMetric } from "../../../../shared/checkBaseline.ts";
import { api } from "../../lib/api.ts";
import { usePoll } from "../../lib/usePoll.ts";
import { barScale, barTop, chipCounts, DEFAULT_SORT, dayBars, parseSortChoice, passChip, rerunWhy, inChip, isSlow, matches, sortChoice, SORT_CHOICES, sortRows, sparkPaths, span, statusChip, tileFacts, tileOf, TILES, toRow, verdictWords, viewOfTile, type Chip, type CiView, type Row, type Sort, type SortKey, type Tile, type TileTone } from "../../lib/ciMetrics.ts";
import { Button, CTRL_H, FilterField, RefreshButton } from "../workspace/Chrome.tsx";
import { Select } from "../Select.tsx";
import { CaretIcon, ChartIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { PrBlank } from "../TriageBoard.tsx";
import { PrNotice } from "../PrNotice.tsx";
import { Chip as StatusChip } from "../git/ui.tsx";
import { Spinner } from "../Spinner.tsx";
import { FailingTestsLens } from "./FailingTestsLens.tsx";
import { CODE_FONT_STYLE } from "../diff/DiffLines.tsx";
import type { FailingTests } from "../../../../shared/types.ts";

const CHIP_TEXT: Record<Chip, { label: string; title: string }> = {
  all: { label: "All", title: "Every check that has run on this repository" },
  slow: { label: "Slow", title: "The newest run is slower than the check's own slowest 1 in 10" },
  rerun: { label: "Re-run passed", title: `Failed, then passed, on the same commit in the last ${RERUN_DAYS} days, over at least ${MIN_SAMPLES} judged runs. That is the job, not a single test: a check that fails on every commit is broken, not re-run` },
  drifting: { label: "Drifting", title: "The last 7 days took 15% longer than the 7 before" },
  failing: { label: "Failing now", title: "The newest run of the check failed. The failing tests it was read from are below" },
};

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

const TILE_TITLE: Record<Tile, string> = {
  pass: `${CHIP_TEXT.all.title}. The rate is each check's own, weighted by its runs`,
  median: `The median of every check's usual time. Opens the slow ones: ${CHIP_TEXT.slow.title.toLowerCase()}`,
  rerun: CHIP_TEXT.rerun.title,
  drifting: CHIP_TEXT.drifting.title,
  failing: CHIP_TEXT.failing.title,
};

/** The hue frames a tile and the ink draws its figure (the ink is the readable one on the wash). */
const TILE_TONE: Record<TileTone, { hue: string; ink: string }> = {
  good: { hue: "var(--success)", ink: "var(--success-ink)" },
  info: { hue: "var(--info)", ink: "var(--info-ink, var(--info))" },
  warn: { hue: "var(--warning)", ink: "var(--warning-ink)" },
  bad: { hue: "var(--error)", ink: "var(--error-ink)" },
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

/** The days as bars, tallest day full height: a day with no success is a stub, never a zero. */
function DayBars({ r }: { r: Row }) {
  const H = 16;
  const bars = useMemo(() => dayBars(r.trend), [r.trend]);
  const t = tintOf(r);
  return (
    <span className="flex items-end gap-px shrink-0" style={{ height: H }} aria-hidden>
      {bars.map((b, i) => (
        <span key={i} className="rounded-sm"
          style={{ width: 3, height: b == null ? 2 : Math.max(3, Math.round(b * H)), background: b == null ? "color-mix(in srgb, var(--text) 18%, transparent)" : t.bar, opacity: b == null ? 1 : 0.55 + 0.45 * (i / Math.max(1, bars.length - 1)) }} />
      ))}
    </span>
  );
}

const FACT = "flex flex-col gap-0.5 min-w-0";
const FACT_K = "text-[10px] uppercase tracking-wide";

/**
 * One check: a row that opens. Closed it is what the mockup draws; opened it holds what the table's other
 * columns held, so a fact is one press away and never gone.
 */
function Line({ r, top, open, onToggle }: { r: Row; top: number; open: boolean; onToggle: () => void }) {
  const t = tintOf(r);
  const words = verdictWords(r);
  const week = r.drift != null ? Math.round(r.drift * 100) : null;
  const status = statusChip(r);
  const pass = passChip(r);
  const label = r.workflow ? `${r.workflow} / ${r.name}` : r.name;
  return (
    <div role="row" className="agx-hover" style={{ borderTop: QUIET }}>
      <button type="button" role="cell" aria-expanded={open} onClick={onToggle} title={open ? "Close the details" : "Open the details: slow end, fails, this run against its own history"}
        className="agx-btn agx-cirow w-full grid items-center gap-x-3 px-3 text-left" style={{ minHeight: 36 }}>
        <span className="flex items-center gap-2 min-w-0">
          <span aria-hidden className="flex shrink-0" style={{ color: "var(--text4)", transform: open ? undefined : "rotate(-90deg)" }}><CaretIcon size={ICON.xs} /></span>
          <span className="truncate text-[12px]" style={{ ...CODE_FONT_STYLE, color: "var(--text)" }}>{label}</span>
          {week != null && <span className="inline-flex items-center gap-0.5 text-[10px] shrink-0 tabular-nums" style={{ color: "var(--text3)" }} title="The last 7 days took longer than the 7 before"><span aria-hidden className="flex" style={{ transform: "rotate(180deg)" }}><CaretIcon size={ICON.xs} /></span>{week}%</span>}
        </span>
        <DayBars r={r} />
        <span className="text-right text-[11px] tabular-nums" style={{ ...CODE_FONT_STYLE, color: "var(--text2)" }} title="What it usually takes: the median of its successful runs">{r.usual != null ? span(r.usual) : "\u2014"}</span>
        <span className="flex justify-end"><StatusChip tone={pass.tone} title="The share of its judged runs that passed; a cancelled run does not count">{pass.label}</StatusChip></span>
      </button>
      {open && (
        <div className="grid gap-x-6 gap-y-3 px-3 pb-3 pt-1" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", background: "color-mix(in srgb, var(--text) 2.5%, transparent)" }}>
          <div className={FACT}><span className={FACT_K} style={{ color: "var(--text3)" }}>Slow end</span><span className="text-[11px] tabular-nums" style={{ color: "var(--text2)" }} title="The slowest 1 in 10 of its successful runs">{r.slowEnd != null ? span(r.slowEnd) : "\u2014"}</span></div>
          <div className={FACT}><span className={FACT_K} style={{ color: "var(--text3)" }}>Fails</span>
            <span className="text-[11px] tabular-nums" style={{ color: "var(--text2)" }} title={rerunWhy(r.sameCommit) || "Failures over successes plus failures; cancelled runs do not count"}>{r.failRate != null ? `${Math.round(r.failRate * 100)}%` : "\u2014"}</span></div>
          <div className={FACT}><span className={FACT_K} style={{ color: "var(--text3)" }}>14 days</span><span className="inline-flex items-center"><Spark r={r} /></span></div>
          <div className={FACT} style={{ gridColumn: "span 2" }}>
            <span className={FACT_K} style={{ color: "var(--text3)" }} title="The newest run of the check, judged against that check's own usual">This run against its own history</span>
            <span className="flex items-center gap-3 min-w-0">
              <Bar r={r} top={top} />
              <span className="text-[11px] tabular-nums shrink-0 w-[52px] text-right" style={{ color: t.ink }}>{r.thisRun != null ? span(r.thisRun) : "\u2014"}{words ? <span className="sr-only"> {words}</span> : null}</span>
            </span>
          </div>
          <div className={FACT}><span className={FACT_K} style={{ color: "var(--text3)" }}>Status</span>
            <span className="flex items-center min-h-[18px]">{status ? <StatusChip tone={TONE[status.tone]} title={r.rerun ? rerunWhy(r.sameCommit) : words || undefined}>{status.label}</StatusChip> : <span className="text-[11px]" style={{ color: "var(--text3)" }}>usual</span>}</span></div>
        </div>
      )}
    </div>
  );
}

/** A hairline quieter than the house LINE: forty rows of full-strength rules read as a grid, not a list. */
const QUIET = "1px solid color-mix(in srgb, var(--text) 6%, transparent)";

export function CiMetrics({ root, repo, active, filterText, onFilterText }: {
  root: string; repo: string; active: boolean;
  /** The text the panel's one search box holds. The bar owns the box, so this view draws none. */
  filterText: string;
  onFilterText: (v: string) => void;
}) {
  const [checks, setChecks] = useState<CheckMetric[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [chip, setChip] = useState<CiView>("all");
  // The failing tests: read from this server's own record with every poll (no GitHub request), refreshed from GitHub only when asked.
  const [tests, setTests] = useState<FailingTests | null>(null);
  const [testsBusy, setTestsBusy] = useState(false);
  const [testsErr, setTestsErr] = useState("");
  /** The failing tests' own filter box: it narrows that list only, on top of the bar's text. */
  const [testQuery, setTestQuery] = useState("");
  // What the last refresh did stays on the page: the next poll re-reads the table and carries no refresh of its own.
  const [lastRefresh, setLastRefresh] = useState<FailingTests["refresh"]>(undefined);
  const refreshed = useRef(new Set<string>());
  const query = filterText;
  const setQuery = onFilterText;
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  /** The checks whose details are open. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((k: string) => setOpened((cur) => { const n = new Set(cur); if (!n.delete(k)) n.add(k); return n; }), []);

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
    if (chip !== "failing" || !tests || refreshed.current.has(root)) return;
    refreshed.current.add(root);
    if (tests.failedRuns > tests.readRuns) refreshTests();
  }, [chip, tests, root, refreshTests]);
  // The runs it reads are recorded whenever a Checks tab loads, so a minute is as fresh as anything upstream of it.
  usePoll(active, () => { load(); loadTests(); }, 60_000);

  const rows = useMemo(() => (checks ?? []).map(toRow), [checks]);
  const found = useMemo(() => rows.filter((r) => matches(r, query)), [rows, query]);
  const counts = useMemo(() => chipCounts(found), [found]);
  const shown = useMemo(() => sortRows(found.filter((r) => inChip(chip, r)), sort), [found, chip, sort]);
  const top = useMemo(() => barTop(rows), [rows]);
  const total = useMemo(() => rows.reduce((n, r) => n + r.runs, 0), [rows]);
  const facts = useMemo(() => tileFacts(found, counts), [found, counts]);

  if (err && !checks) {
    return (
      <PrNotice title="Could not read the check history" reason={err}
        actions={<Button tone="primary" size="hit" pending={busy} onClick={load}>Try again</Button>}>
        The local record is unreadable.
      </PrNotice>
    );
  }
  if (!checks) return <div className="flex items-center gap-2 text-[11px] px-4 py-6" style={{ color: "var(--text3)" }}><Spinner /> Reading the recorded runs…</div>;
  if (!rows.length) {
    return (
      <PrBlank icon={<ChartIcon size={ICON.lg} />} title="0 runs recorded" sentence="Runs are recorded as each pull request's Checks tab loads." ghost>
        <RefreshButton onRefresh={load} busy={busy} title="Read the recorded runs again" />
      </PrBlank>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4" role="region" aria-label="CI metrics">
      <div className="agx-tiles2" role="group" aria-label="Which checks">
        {TILES.map((t) => {
          const on = tileOf(chip) === t;
          const f = facts[t];
          const tone = TILE_TONE[f.tone];
          return (
            <button key={t} type="button" aria-pressed={on} onClick={() => setChip(viewOfTile(t))} title={TILE_TITLE[t]}
              className="agx-tile2 agx-btn" style={{ "--c": tone.hue, "--ink": tone.ink } as CSSProperties}>
              <div className="agx-tile2-k">{f.label}</div>
              <div className="agx-tile2-v">{f.value}</div>
              <div className="agx-tile2-d">{f.detail}</div>
            </button>
          );
        })}
      </div>
      <div className="agx-cibox">
        <div className="agx-cibox-h">
          <ChartIcon size={ICON.sm} />Check history
          <small className="truncate">{shown.length} of {rows.length} · {repo ? `${repo} · ` : ""}{total} runs recorded as each pull request's Checks tab loads</small>
          <span className="flex-1" />
          <FilterField value={query} onChange={setQuery} placeholder="Filter checks" label="Filter checks by name or workflow" className="!h-[28px] !w-[200px] !text-[11px]" />
          <Select value={sortChoice(sort)} options={SORT_CHOICES.map((c) => ({ value: c.value, label: c.label }))} onChange={(v) => setSort(parseSortChoice(v))}
            title="Sort the checks" align="right" className="agx-select rounded-lg px-2 text-[11px] outline-none max-w-[190px]" style={{ height: CTRL_H.regular }} />
          <RefreshButton onRefresh={() => { load(); loadTests(); }} busy={busy} title="Read the recorded runs again" />
        </div>
        <div role="table" aria-label="Checks">
          {shown.length ? shown.map((r) => <Line key={r.key} r={r} top={top} open={opened.has(r.key)} onToggle={() => toggle(r.key)} />) : (
            <div className="text-[11px] px-3 py-6 flex items-center gap-2" style={{ color: "var(--text3)", borderTop: QUIET }}>
              {query ? <>No check matches “{query}”.</> : "No check matches this tile."}
              {query && <button type="button" className="agx-btn underline underline-offset-2" style={{ color: "var(--text2)" }} onClick={() => setQuery("")}>Clear the filter</button>}
            </div>
          )}
          <details className="text-[10px] px-3 py-2" style={{ color: "var(--text3)", borderTop: QUIET }}>
            <summary className="cursor-pointer select-none">How to read an opened row</summary>
            <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1.5">
              <span>bar = 0 → usual (solid) → slowest 1 in 10 (faint)</span>
              <span>marker = this run, coloured by its own history</span>
              <span>dashed line = slowest 1 in 10</span>
            </div>
          </details>
        </div>
      </div>
      <FailingTestsLens data={tests && { ...tests, refresh: lastRefresh }} query={query} testQuery={testQuery} onTestQuery={setTestQuery}
        busy={testsBusy} error={testsErr} onRefresh={refreshTests} />
    </div>
  );
}
