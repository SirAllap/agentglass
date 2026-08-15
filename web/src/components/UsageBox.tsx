import { useSyncExternalStore } from "react";
import { Panel } from "./Panel.tsx";
import {
  subscribeProviderUsage, providerUsage, usageLoaded,
  usedColor, resetLabel, ageLabel,
} from "../lib/usageStore.ts";
import type { ProviderUsage, QuotaWindow } from "../../../shared/types.ts";

/**
 * Plan quota for every provider the cockpit can drive.
 *
 * Three states have to stay distinguishable here, and collapsing any two of
 * them is the bug this box exists to avoid: LOADING (the first fetch is out),
 * UNAVAILABLE (the provider cannot tell us, and the note says why), and STALE
 * (a real reading, with its age). A blank row is none of those and would be
 * read as "you have used nothing".
 */
function Meter({ label, used, resets }: { label: string; used: number; resets: string | null }) {
  const color = usedColor(used);
  const pct = Math.max(0, Math.min(100, used));
  return (
    <div className="flex items-center gap-2 min-w-0"
      title={`${label}: ${used}% used${resets ? ` — resets ${resetLabel(resets)}` : ""}`}>
      <span className="text-[9px] uppercase tracking-[0.14em] t-dim2 w-11 shrink-0">{label}</span>
      <div className="h-1.5 flex-1 min-w-0 rounded-full overflow-hidden"
        style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
        {/* Nothing at all at 0%: a rounded nub reads as "some", and the one
            number this panel must never overstate is consumption. */}
        {pct > 0 && (
          <div className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${pct}%`,
              background: `linear-gradient(90deg, color-mix(in srgb, ${color} 45%, transparent), ${color})`,
            }} />
        )}
      </div>
      {/* When a window comes back is only decision-relevant for the window
          that is closest to running out, and that one is the headline, where
          it gets the full "resets Wed 3:00 PM" rather than two cramped
          characters. The rest keep it in the row's tooltip. */}
      <span className="text-[11px] font-semibold tabular-nums shrink-0 w-8 text-right" style={{ color }}>{used}%</span>
    </div>
  );
}

// Tailwind's `divide-y` sets border-top-width on children via `& > * + *`, but
// never touches border-color — Preflight resets border-color to currentColor
// on every element and it isn't inherited, so a parent's inline colour never
// reaches the divider. Each row after the first carries its own explicit
// border instead, which is provably correct regardless of Tailwind config.
const DIVIDER = "1px solid color-mix(in srgb, var(--border) 30%, transparent)";

function Row({ u, first }: { u: ProviderUsage; first: boolean }) {
  const age = ageLabel(u.observedAt);
  return (
    <div className="flex flex-col gap-1.5 py-2.5" style={first ? undefined : { borderTop: DIVIDER }}>
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-[11.5px] font-medium truncate" style={{ color: "var(--text)" }}>{u.label}</span>
        {u.plan && <span className="chip shrink-0 text-[9px] uppercase tracking-wide">{u.plan}</span>}
        {/* The age belongs next to the number it qualifies, not in a tooltip:
            a weeks-old Codex reading looks exactly like a fresh one. */}
        {u.available && age && <span className="ml-auto text-[9.5px] t-dim2 shrink-0">{age}</span>}
        {/* No "no reading" chip here: the note under the row already says the
            absence in its own words ("Quota not reported."), and a chip saying
            it again is the duplication that copy was shortened to remove. */}
      </div>
      {u.available
        ? (u.windows.length
          ? u.windows.map((w) => <Meter key={w.label} label={w.label} used={w.usedPercent} resets={w.resetsAt} />)
          // The type allows an empty windows array even though upstream never sends
          // one today — a header with nothing under it is the same blank-row bug.
          : <span className="text-[10px] t-dim2 leading-snug">No quota windows reported.</span>)
        // Same bug, other branch: unavailable with no note would render an empty line.
        : <span className="text-[10px] t-dim2 leading-snug">{u.note ?? "No usage note provided."}</span>}
    </div>
  );
}

/**
 * The panel-level decision, pulled out so it can be tested without rendering.
 *
 * `usageStore`'s `firstFetchDone` flips true in a `.finally()`, so it is true
 * whether the fetch succeeded or failed — and a failed fetch deliberately
 * leaves `snapshot` (and so `rows`) at null, to keep the last good reading
 * standing. That combination — loaded, no rows — is reachable on the very
 * first poll if the server is down, and is a fourth state distinct from
 * "loading" and "have data": the server was unreachable, not merely slow.
 */
export function panelState(loaded: boolean, rows: ProviderUsage[] | null): "loading" | "unreachable" | "empty" | "rows" {
  // An empty array is not "have data" — it is the answer you get when every
  // agent with quota is disconnected in Settings. Falling into the rows branch
  // would map it onto a panel with no rows in it, which reads as "you have used
  // nothing" rather than "you asked not to be shown this".
  if (rows) return rows.length ? "rows" : "empty";
  return loaded ? "unreachable" : "loading";
}

/**
 * The window that runs out first, across every provider.
 *
 * This is the question the panel is opened to answer — the meters below it are
 * the detail behind it — so it gets stated once, in full size, instead of
 * being left for the eye to find among five bars of similar length. Providers
 * that cannot report are skipped rather than counted as zero: "nothing is
 * close to its limit" and "nobody would say" are different answers.
 */
export function tightestWindow(rows: ProviderUsage[] | null): { provider: string; window: QuotaWindow } | null {
  let best: { provider: string; window: QuotaWindow } | null = null;
  for (const u of rows ?? []) {
    if (!u.available) continue;
    for (const w of u.windows) {
      if (!best || w.usedPercent > best.window.usedPercent) best = { provider: u.label, window: w };
    }
  }
  return best;
}

/** The headline: one number, big, in the colour its level has earned. */
function Headline({ provider, window: w }: { provider: string; window: QuotaWindow }) {
  const color = usedColor(w.usedPercent);
  return (
    <div className="shrink-0 pb-2.5" style={{ borderBottom: DIVIDER }}>
      <div className="text-[9px] uppercase tracking-[0.16em] t-dim2">Closest to its limit</div>
      <div className="flex items-baseline gap-2.5 mt-1 min-w-0">
        {/* A 30px number in a 36px line box. `leading-none` sets the box to
            exactly the font size, which the digits overshoot — harmless on its
            own, but it makes the panel measure as overflowing when it is not,
            and this is the panel whose whole job is now to never scroll. */}
        <span className="font-sans text-[30px] font-semibold leading-[1.2] tabular-nums" style={{ color }}>
          {w.usedPercent}%
        </span>
        <div className="flex flex-col min-w-0 gap-1">
          <span className="text-[11px] truncate" style={{ color: "var(--text2)" }}>{provider} · {w.label}</span>
          {w.resetsAt && <span className="text-[10px] t-dim2 truncate">resets {resetLabel(w.resetsAt)}</span>}
        </div>
      </div>
    </div>
  );
}

export function UsageBox() {
  const rows = useSyncExternalStore(subscribeProviderUsage, providerUsage, () => null);
  const loaded = useSyncExternalStore(subscribeProviderUsage, usageLoaded, () => false);
  const state = panelState(loaded, rows);
  const top = tightestWindow(rows);

  return (
    <Panel eyebrow="Usage" title="Plan quota" right={<span className="text-[10px] t-dim2">By provider</span>}>
      <div className="h-full min-h-0 flex flex-col">
        {state === "loading" && <span className="text-[11px] t-dim2 py-2">Reading plan quota…</span>}
        {state === "unreachable" && <span className="text-[11px] t-dim2 py-2">Could not reach the server for plan quota.</span>}
        {state === "empty" && <span className="text-[11px] t-dim2 py-2 leading-snug">No connected agent reports plan quota. Connect one in Settings › Agents.</span>}
        {top && <Headline provider={top.provider} window={top.window} />}
        {/* No scroller. Anthropic's window list has no fixed length — the
            per-model weekly buckets in providerusage.ts are pushed as the plan
            reports them — so this panel sizes to whatever it is given and the
            grid cell around it grows to match. A quota you have to scroll to
            find is a quota you will not look at. */}
        {rows && rows.map((u, i) => <Row key={u.provider} u={u} first={i === 0} />)}
      </div>
    </Panel>
  );
}
