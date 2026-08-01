import { useSyncExternalStore } from "react";
import { Panel } from "./Panel.tsx";
import {
  subscribeProviderUsage, providerUsage, usageLoaded,
  usedColor, resetLabel, ageLabel,
} from "../lib/usageStore.ts";
import type { ProviderUsage } from "../../../shared/types.ts";

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
  return (
    <div className="flex items-center gap-2 min-w-0"
      title={`${label}: ${used}% used${resets ? ` — resets ${resetLabel(resets)}` : ""}`}>
      <span className="text-[9px] uppercase tracking-[0.14em] t-dim2 w-11 shrink-0">{label}</span>
      <div className="h-1.5 flex-1 min-w-0 rounded-full overflow-hidden"
        style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${Math.min(100, used)}%`, background: color }} />
      </div>
      <span className="text-[11px] font-semibold tabular-nums shrink-0" style={{ color }}>{used}%</span>
    </div>
  );
}

function Row({ u }: { u: ProviderUsage }) {
  const age = ageLabel(u.observedAt);
  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-[11.5px] font-medium truncate" style={{ color: "var(--text)" }}>{u.label}</span>
        {u.plan && <span className="chip shrink-0 text-[9px] uppercase tracking-wide">{u.plan}</span>}
        {/* The age belongs next to the number it qualifies, not in a tooltip:
            a weeks-old Codex reading looks exactly like a fresh one. */}
        {u.available && age && <span className="ml-auto text-[9.5px] t-dim2 shrink-0">{age}</span>}
      </div>
      {u.available
        ? u.windows.map((w) => <Meter key={w.label} label={w.label} used={w.usedPercent} resets={w.resetsAt} />)
        : <span className="text-[10px] t-dim2 leading-snug">{u.note}</span>}
    </div>
  );
}

export function UsageBox() {
  const rows = useSyncExternalStore(subscribeProviderUsage, providerUsage, () => null);
  const loaded = useSyncExternalStore(subscribeProviderUsage, usageLoaded, () => false);

  return (
    <Panel eyebrow="Usage" title="Plan quota" right={<span className="text-[10px] t-dim2">By provider</span>}>
      <div className="h-full min-h-0 overflow-y-auto agx-scroll flex flex-col divide-y"
        style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
        {!loaded && !rows && <span className="text-[11px] t-dim2 py-2">Reading plan quota…</span>}
        {rows?.map((u) => <Row key={u.provider} u={u} />)}
      </div>
    </Panel>
  );
}
