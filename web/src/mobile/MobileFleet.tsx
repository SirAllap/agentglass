import { Empty } from "./mobileUi.tsx";
import { fmtAgo, fmtUsd, fmtTokens } from "../lib/format.ts";
import { orderInsights, spendByModel, spendByApp, errorRate, type SpendRow } from "./fleet.ts";
import type { Insight, StatsSummary } from "../../../shared/types.ts";

/**
 * The fleet, as a whole.
 *
 * Everything here was already computed and served and had no route to a phone.
 * `/insights` names the session going in circles, the one burning tokens, the
 * one throwing errors; `/stats` says which model and which runtime the money
 * went to. The Settings sheet showed three numbers and stopped, so the two
 * questions you actually have when you are away from the desk — "is anything
 * stuck" and "what is this costing me" — had no answer on the device in your
 * hand.
 *
 * Deliberately not a chart. On a phone a bar is a comparison and nothing else:
 * these are ranked lists with a width, which is a comparison you can read at
 * arm's length, and the number is printed beside it for the case where you
 * cannot.
 */
export const FLEET_CSS = `
.mb-ins{border-radius:16px;overflow:hidden;background:var(--mb-card);
  border:1px solid color-mix(in srgb,var(--border) 38%,transparent);box-shadow:var(--mb-edge);
  position:relative;width:100%;text-align:left}
.mb-ins::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--text3)}
.mb-ins.bad::before{background:var(--error);width:4px}
.mb-ins.warn::before{background:var(--warning)}
.mb-ins .ih{display:flex;align-items:baseline;gap:8px;padding:11px 13px 0 16px}
.mb-ins .k{font-size:9.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);font-weight:600}
.mb-ins.bad .k{color:var(--error)}
.mb-ins.warn .k{color:var(--warning)}
.mb-ins .at{margin-left:auto;font-size:10.5px;color:var(--text3);white-space:nowrap}
.mb-ins .t{display:block;padding:5px 13px 0 16px;font-size:13.5px;line-height:1.35;color:var(--text)}
.mb-ins .s{display:block;padding:5px 13px 12px 16px;font-size:11.5px;color:var(--text3);line-height:1.5;
  overflow-wrap:anywhere}

/* A ranked list with a width. The number stays printed beside it — a bar you
   cannot put a value on is decoration, which is what the home screen's
   fourteen animated bars were before they were taken out. */
.mb-bar{display:block;margin-bottom:9px}
.mb-bar .l{display:flex;align-items:baseline;gap:8px;font-size:11.5px;margin-bottom:4px}
.mb-bar .l b{font-weight:500;color:var(--text2);min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.mb-bar .l .v{margin-left:auto;flex:none;color:var(--text3);font-variant-numeric:tabular-nums}
/* display:block, because these are spans — a button may not contain a div, and
   an inline element silently ignores a height, so the track and its fill were
   both drawn 0px tall and the whole comparison was invisible. */
.mb-bar .g{display:block;height:7px;border-radius:4px;
  background:color-mix(in srgb,var(--border) 34%,transparent);overflow:hidden}
.mb-bar .g i{display:block;height:100%;border-radius:4px;background:var(--primary-hover);
  transition:width .4s cubic-bezier(.2,.85,.25,1)}
.mb-bar.dim .g i{background:var(--text3)}
`;

const KIND: Record<Insight["kind"], string> = {
  loop: "Going in circles",
  spend: "Spending",
  errors: "Errors",
  burn: "Burn rate",
};

export function MobileFleet({ insights, stats, onOpenInsight }: {
  insights: Insight[];
  stats: StatsSummary | null;
  /** Null when the insight names no session, or names one this device cannot
   *  resolve — see sessionForInsight. */
  onOpenInsight: (i: Insight) => void;
}) {
  const rows = orderInsights(insights);
  const models = stats ? spendByModel(stats.by_model) : [];
  const apps = stats ? spendByApp(stats.by_app) : [];
  const rate = errorRate(stats?.totals);
  const t = stats?.totals;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-eyebrow" style={{ marginBottom: 9 }}>
          What needs looking at{rows.length ? ` · ${rows.length}` : ""}
        </div>
        {rows.length === 0 ? (
          <Empty glyph="◎" title="Nothing is misbehaving"
            body="No loops, no runaway spend, no bursts of errors in the window." />
        ) : (
          <div className="flex flex-col gap-2.5">
            {rows.map((i) => (
              <button key={i.id} className={`mb-ins mb-press ${i.severity}`} onClick={() => onOpenInsight(i)}>
                <span className="ih">
                  <span className="k">{KIND[i.kind]}</span>
                  <span className="at">{fmtAgo(i.ts)}</span>
                </span>
                <span className="t">{i.title}</span>
                <span className="s">{i.detail}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-eyebrow" style={{ marginBottom: 9 }}>Today</div>
        <div className="mb-card p-3 flex flex-col gap-2">
          <Fig label="Spent" value={t ? fmtUsd(t.cost_usd) : "—"} />
          <Fig label="Tokens" value={t ? fmtTokens(t.input_tokens + t.output_tokens) : "—"} />
          <Fig label="Sessions" value={t ? String(t.sessions) : "—"} />
          <Fig label="Tool calls" value={t?.tool_calls != null ? String(t.tool_calls) : "—"} />
          {/* Null rather than a number, when the server did not send the
              narrower count — see errorRate. A wrong rate is worse than none. */}
          <Fig label="Failed calls"
            value={rate == null ? "—" : `${(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}%`}
            tint={rate != null && rate > 0.05 ? "var(--warning)" : undefined} />
        </div>
      </div>

      <Bars title="Where the money went" rows={models} empty="Nothing has been spent in this window." />
      <Bars title="By runtime" rows={apps} empty="No agent has run in this window." />
    </div>
  );
}

function Fig({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <div className="flex items-baseline gap-3 text-[12px]">
      <span style={{ color: "var(--text3)" }}>{label}</span>
      <span className="flex-1" />
      <span className="mb-tnum font-semibold" style={{ color: tint ?? "var(--text)" }}>{value}</span>
    </div>
  );
}

function Bars({ title, rows, empty }: { title: string; rows: SpendRow[]; empty: string }) {
  return (
    <div>
      <div className="mb-eyebrow" style={{ marginBottom: 9 }}>{title}</div>
      {rows.length === 0 ? (
        <p className="text-[11.5px]" style={{ color: "var(--text3)" }}>{empty}</p>
      ) : (
        <div className="mb-card p-3">
          {rows.map((r) => (
            <div key={r.name} className={`mb-bar${r.unpriced ? " dim" : ""}`}>
              <span className="l">
                <b>{r.name}</b>
                <span className="v">
                  {/* A model with no published price has no cost, and printing
                      $0.00 would read as "this one was free". */}
                  {r.unpriced ? "no price" : fmtUsd(r.cost)}
                  {r.sessions ? ` · ${r.sessions}` : ""}
                </span>
              </span>
              <span className="g"><i style={{ width: `${Math.round(r.share * 100)}%` }} /></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
