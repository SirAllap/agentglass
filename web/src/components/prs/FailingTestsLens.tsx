/*
 * The CI view's "Failing tests": each failing test the app has read, counted over
 * runs and pull requests, with a verdict that says only what was seen.
 *
 * The table is read from this server's own record and costs nothing. The only
 * thing that reaches GitHub is the refresh, which reads a few failed runs it has
 * not read (newest first) and says up front what that may cost. A failure is read
 * for its tests once, and kept.
 */
import { CODE_FONT_STYLE } from "../diff/DiffLines.tsx";
import { LINE } from "../workspace/Chrome.tsx";
import { Spinner } from "../Spinner.tsx";
import { LENS_REFRESH_CAP } from "../../../../shared/failureVerdict.ts";
import type { FailingTestRow, FailingTests } from "../../../../shared/types.ts";
import { VERDICT_NOTE, budgetLine, coverageLine, dateWords, matchesTest, readingLine, refreshLine, rowVerdict, verdictTone, type Tone } from "../../lib/failingTests.ts";

const COLS = "minmax(260px, 2.6fr) 96px 56px 48px 84px 84px minmax(150px, 1fr)";
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

const HEAD = ["Test", "Check", "Runs", "PRs", "First seen", "Last seen", "Verdict"];

function Skeleton({ n }: { n: number }) {
  return (
    <div aria-hidden>
      <style>{`@keyframes agxpulse{0%,100%{opacity:.35}50%{opacity:.7}}@media (prefers-reduced-motion:reduce){.agx-sk{animation:none!important}}`}</style>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} role="row" className="grid items-center gap-x-3 px-3" style={{ gridTemplateColumns: COLS, minHeight: 50, borderTop: LINE }}>
          <div className="flex flex-col gap-1.5">
            <span className="agx-sk rounded" style={{ height: 8, width: `${58 + ((i * 13) % 30)}%`, background: "color-mix(in srgb, var(--border) 55%, transparent)", animation: `agxpulse 1.4s ease-in-out ${i * 0.1}s infinite` }} />
            <span className="agx-sk rounded" style={{ height: 6, width: `${30 + ((i * 9) % 20)}%`, background: "color-mix(in srgb, var(--border) 38%, transparent)", animation: `agxpulse 1.4s ease-in-out ${i * 0.1 + 0.2}s infinite` }} />
          </div>
          <span /><span /><span /><span /><span />
          <span className="text-[10px] px-1.5 py-px rounded-full w-fit" style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--text) 8%, transparent)" }}>Reading…</span>
        </div>
      ))}
    </div>
  );
}

export function FailingTestsLens({ data, query, busy, error }: { data: FailingTests | null; query: string; busy: boolean; error: string }) {
  if (!data) {
    return error
      ? <div className="text-[11px] px-1 py-6" style={{ color: "var(--text3)" }}>{error}</div>
      : <div className="flex items-center gap-2 text-[11px] px-1 py-6" style={{ color: "var(--text3)" }}><Spinner /> Reading the failures…</div>;
  }
  const rows = data.rows.filter((r) => matchesTest(r, query));
  const toFetch = Math.min(Math.max(data.failedRuns - data.readRuns, 0), CAP);
  const last = data.refresh;
  return (
    <div className="flex flex-col gap-2" role="region" aria-label="Failing tests">
      {busy && (
        <div className="flex items-center gap-2 text-[11px] px-1" style={{ color: "var(--text2)" }} role="status">
          <Spinner className="" />{readingLine(data, CAP)}
        </div>
      )}
      {!busy && last && (
        <div className="text-[10.5px] px-1" style={{ color: last.error ? "var(--warning-ink)" : "var(--text3)" }}>{refreshLine(last)}</div>
      )}
      <div role="table" aria-label="Failing tests" className="rounded-xl overflow-hidden" style={{ background: "var(--surface-card)", border: LINE, boxShadow: "var(--surface-lift)" }}>
        <div role="row" className="grid items-center gap-x-3 px-3" style={{ gridTemplateColumns: COLS, minHeight: 30, background: "var(--surface-inset)" }}>
          {HEAD.map((h, i) => <div key={h} role="columnheader" className="text-[10px]" style={{ color: "var(--text3)", textAlign: i === 2 || i === 3 ? "right" : "left" }}>{h}</div>)}
        </div>
        {rows.map((r) => (
          <div key={`${r.title}\u0001${r.gist}`} role="row" className="grid items-center gap-x-3 px-3 py-2" style={{ gridTemplateColumns: COLS, minHeight: 50, borderTop: LINE }}>
            <div role="cell" className="min-w-0">
              <div className="truncate text-[11px] font-semibold" title={r.title} style={{ ...CODE_FONT_STYLE, color: "var(--text)" }}>{r.title}</div>
              {r.gist && <div className="truncate text-[10px]" title={r.gist} style={{ color: "var(--text3)" }}>{r.gist}</div>}
            </div>
            <div role="cell" className="truncate text-[11px]" style={{ color: "var(--text2)" }}>{r.check}</div>
            <div role="cell" className="text-right text-[11px] tabular-nums" style={{ color: "var(--text)" }}>{r.runs}</div>
            <div role="cell" className="text-right text-[11px] tabular-nums" style={{ color: "var(--text)" }}>{r.prs}</div>
            <div role="cell" className="text-[11px] tabular-nums" style={{ color: "var(--text2)" }}>{dateWords(r.firstSeen)}</div>
            <div role="cell" className="text-[11px] tabular-nums" style={{ color: "var(--text2)" }}>{dateWords(r.lastSeen)}</div>
            <div role="cell"><Verdict r={r} /></div>
          </div>
        ))}
        {busy && toFetch > 0 && <Skeleton n={Math.min(toFetch, 2)} />}
        {!rows.length && !busy && (
          <div className="text-[11px] px-3 py-6" style={{ color: "var(--text3)", borderTop: LINE }}>
            {data.rows.length ? "No test matches." : data.failedRuns ? "No failing test read yet. Press refresh to read the failed runs." : "No failing test recorded."}
          </div>
        )}
        <div className="text-[10px] px-3 py-2 flex flex-col gap-1" style={{ color: "var(--text3)", borderTop: LINE }}>
          <span>{VERDICT_NOTE}</span>
          <span>{coverageLine(data)} {budgetLine(CAP)}</span>
        </div>
      </div>
    </div>
  );
}
