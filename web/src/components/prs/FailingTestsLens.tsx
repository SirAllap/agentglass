/*
 * The CI view's "Failing tests": each failing test the app has read, counted over
 * runs and pull requests, with a verdict that says only what was seen.
 *
 * The table is read from this server's own record and costs nothing. The only
 * thing that reaches GitHub is the refresh, which reads a few failed runs it has
 * not read (newest first) and says up front what that may cost. A failure is read
 * for its tests once, and kept.
 *
 * A box under the check history (the mockup's "Failing tests"): an icon, the
 * count, a filter of its own and the refresh in its header. Each test is a row
 * with its check, its title, its verdict and how many pull requests it failed
 * on; opened, it holds what the old columns held (the gist, runs, pull
 * requests, first and last seen). The check history's filter narrows it too, so
 * a name typed there finds a test as well as a check.
 */
import { CODE_FONT_STYLE } from "../diff/DiffLines.tsx";
import { useState } from "react";
import { FilterField, LINE, RefreshButton } from "../workspace/Chrome.tsx";
import { CaretIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { Chip as PrChip } from "../git/ui.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Spinner } from "../Spinner.tsx";
import { LENS_REFRESH_CAP } from "../../../../shared/failureVerdict.ts";
import type { FailingTestRow, FailingTests } from "../../../../shared/types.ts";
import { VERDICT_NOTE, budgetLine, coverageLine, dateWords, matchesTest, readingLine, refreshLine, rowVerdict, verdictTone, type Tone } from "../../lib/failingTests.ts";

const CAP = LENS_REFRESH_CAP;

const TONE: Record<Tone, { ink: string; dot: string | null; bg: string }> = {
  bad: { ink: "var(--error-ink)", dot: "var(--error)", bg: "color-mix(in srgb, var(--error) 10%, transparent)" },
  warn: { ink: "var(--warning-ink)", dot: "var(--warning)", bg: "color-mix(in srgb, var(--warning) 12%, transparent)" },
  info: { ink: "var(--info-ink)", dot: "var(--info)", bg: "color-mix(in srgb, var(--info) 10%, transparent)" },
  quiet: { ink: "var(--text2)", dot: null, bg: "color-mix(in srgb, var(--text) 8%, transparent)" },
};

function Verdict({ r }: { r: FailingTestRow }) {
  const t = TONE[verdictTone(r.verdict)];
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] px-1.5 py-px rounded-full whitespace-nowrap" style={{ color: t.ink, background: t.bg }}>
      {t.dot && <span className="rounded-full" style={{ width: 6, height: 6, background: t.dot }} />}
      {rowVerdict(r)}
    </span>
  );
}

function Skeleton({ n }: { n: number }) {
  return (
    <div aria-hidden>
      <style>{`@keyframes agxpulse{0%,100%{opacity:.35}50%{opacity:.7}}@media (prefers-reduced-motion:reduce){.agx-sk{animation:none!important}}`}</style>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} role="row" className="flex items-center gap-3 px-3" style={{ minHeight: 36, borderTop: LINE }}>
          <span className="agx-sk rounded" style={{ height: 8, width: `${42 + ((i * 13) % 30)}%`, background: "color-mix(in srgb, var(--border) 55%, transparent)", animation: `agxpulse 1.4s ease-in-out ${i * 0.1}s infinite` }} />
          <span className="flex-1" />
          <span className="text-[10px] px-1.5 py-px rounded-full w-fit" style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--text) 8%, transparent)" }}>Reading…</span>
        </div>
      ))}
    </div>
  );
}

const FACT_K = "text-[10px] uppercase tracking-wide";

/** One failing test: a row that opens onto the facts the old columns held. */
function TestRow({ r, open, onToggle }: { r: FailingTestRow; open: boolean; onToggle: () => void }) {
  const dot = TONE[verdictTone(r.verdict)].dot ?? "var(--text3)";
  return (
    <div role="row" style={{ borderTop: LINE }}>
      <button type="button" role="cell" aria-expanded={open} onClick={onToggle} title={r.gist ? `${r.title}\n${r.gist}` : r.title}
        className="agx-btn w-full flex items-center gap-2 px-3 text-left" style={{ minHeight: 36 }}>
        <span aria-hidden className="flex shrink-0" style={{ color: "var(--text4)", transform: open ? undefined : "rotate(-90deg)" }}><CaretIcon size={ICON.xs} /></span>
        <span className="shrink-0 flex" style={{ color: dot }}><WarningIcon size={ICON.sm} /></span>
        <span className="flex-1 min-w-0 truncate text-[12px]" style={{ ...CODE_FONT_STYLE, color: "var(--text)" }}>{r.check} · {r.title}</span>
        <Verdict r={r} />
        {/* "This PR only" already names its pull request, so no count beside it */}
        {r.verdict.kind !== "this-pr" && r.prs > 0 && <PrChip title="Pull requests this failed on">{r.prs} PR{r.prs === 1 ? "" : "s"}</PrChip>}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-2.5" style={{ background: "color-mix(in srgb, var(--text) 2.5%, transparent)" }}>
          {r.gist && <div className="text-[11px]" style={{ ...CODE_FONT_STYLE, color: "var(--text2)" }}>{r.gist}</div>}
          <div className="grid gap-x-6 gap-y-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))" }}>
            {([["Check", r.check], ["Runs", String(r.runs)], ["PRs", String(r.prs)], ["First seen", dateWords(r.firstSeen)], ["Last seen", dateWords(r.lastSeen)]] as const).map(([k, v]) => (
              <div key={k} className="flex flex-col gap-0.5 min-w-0"><span className={FACT_K} style={{ color: "var(--text3)" }}>{k}</span><span className="text-[11px] tabular-nums truncate" style={{ color: "var(--text)" }}>{v}</span></div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function FailingTestsLens({ data, query, testQuery, onTestQuery, busy, error, onRefresh }: {
  data: FailingTests | null;
  /** The bar's text. */
  query: string;
  /** This box's own filter. */
  testQuery: string;
  onTestQuery: (v: string) => void;
  busy: boolean;
  error: string;
  /** The one thing that reaches GitHub. */
  onRefresh: () => void;
}) {
  const rows = data ? data.rows.filter((r) => matchesTest(r, query) && matchesTest(r, testQuery)) : [];
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const keyOf = (r: FailingTestRow) => `${r.title}\u0001${r.gist}`;
  const toggle = (k: string) => setOpened((cur) => { const n = new Set(cur); if (!n.delete(k)) n.add(k); return n; });
  const toFetch = data ? Math.min(Math.max(data.failedRuns - data.readRuns, 0), CAP) : 0;
  const last = data?.refresh;
  return (
    <div className="agx-cibox" role="region" aria-label="Failing tests">
      <div className="agx-cibox-h">
        <WarningIcon size={ICON.sm} />Failing tests
        {data && <small>{data.rows.length}</small>}
        <span className="flex-1" />
        <FilterField value={testQuery} onChange={onTestQuery} placeholder="Filter tests" label="Filter tests" className="!h-[28px] !w-[200px] !text-[11px]" />
        <RefreshButton onRefresh={onRefresh} busy={busy}
          title={`Read the failed runs it has not read yet: at most ${CAP}, newest first, and the cost is stated below`} />
      </div>
      {!data ? (
        error
          ? <div className="text-[11px] px-3 py-6" style={{ color: "var(--text3)" }}>{error}</div>
          : <div className="flex items-center gap-2 text-[11px] px-3 py-6" style={{ color: "var(--text3)" }}><Spinner /> Reading the failures…</div>
      ) : (
        <>
          {busy && (
            <div className="flex items-center gap-2 text-[11px] px-3 py-2" style={{ color: "var(--text2)" }} role="status">
              <Spinner className="" />{readingLine(data, CAP)}
            </div>
          )}
          {!busy && last && (
            <div className="text-[10.5px] px-3 py-2" style={{ color: last.error ? "var(--warning-ink)" : "var(--text3)" }}>{refreshLine(last)}</div>
          )}
          <div role="table" aria-label="Failing tests">
            {rows.map((r) => <TestRow key={keyOf(r)} r={r} open={opened.has(keyOf(r))} onToggle={() => toggle(keyOf(r))} />)}
            {busy && toFetch > 0 && <Skeleton n={Math.min(toFetch, 2)} />}
            {!rows.length && !busy && (
              <div className="text-[11px] px-3 py-6" style={{ color: "var(--text3)", borderTop: LINE }}>
                {data.rows.length ? "No test matches." : data.failedRuns ? "No failing test read yet. Press refresh to read the failed runs." : "No failing test recorded."}
              </div>
            )}
          </div>
          <details className="text-[10px] px-3 py-2" style={{ color: "var(--text3)", borderTop: LINE }}>
            <summary className="cursor-pointer select-none">How this is counted</summary>
            <div className="flex flex-col gap-1 pt-1.5">
              <span>{VERDICT_NOTE}</span>
              <span>{coverageLine(data)} {budgetLine(CAP)}</span>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
