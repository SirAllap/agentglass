import { PreviewBox, PreviewNote } from "./Frame.tsx";
import { CAP_SAVES, ledgerBars, rereadShare, type CapLabel } from "./logic.ts";

export interface ContextDietPreviewProps {
  cap: CapLabel;
  /** Include what subagents re-read. */
  countSubagents: boolean;
  /** How far back the tally looks, days. */
  windowDays: 7 | 30;
}

/** The context ledger the plugin draws, on demo numbers: how much is re-read, and what the chosen cap would save. */
export function ContextDietPreview({ cap, countSubagents, windowDays }: ContextDietPreviewProps) {
  const bars = ledgerBars(cap);
  const stat = (value: string, tone: string, label: string) => (
    <div className="min-w-0"><b className="block text-[20px]" style={{ color: `var(${tone})` }}>{value}</b><small style={{ color: "var(--text3)" }}>{label}</small></div>
  );
  return (
    <PreviewBox label="Context ledger">
      <div data-preview="context-diet" className="rounded-lg p-4 flex flex-col gap-3 min-w-0" style={{ background: "var(--bg)" }}>
        <div><b className="text-[14px]" style={{ color: "var(--text)" }}>You are not paying for what it writes</b>
          <div className="text-[11px]" style={{ color: "var(--text3)" }}>You are paying for the conversation so far, read again, every turn.</div></div>
        <div className="grid grid-cols-3 gap-3 text-[11px]">
          {stat(`${rereadShare(countSubagents)}%`, "--primary", `of a ${windowDays === 7 ? "week" : "month"}, re-read`)}
          {stat("82%", "--warning-ink", "of that on the main thread")}
          {stat(`${CAP_SAVES[cap]}%`, "--info-ink", `is what a ${cap} cap saves`)}
        </div>
        <div className="flex items-end gap-1" style={{ height: 72 }}>
          {bars.map((b, i) => <i key={i} data-bar={b.over ? "over" : ""} title={`turn ${i + 1}`} className="flex-1 rounded-sm" style={{ height: `${b.h}%`, background: b.over ? "var(--primary)" : "var(--surface-inset)" }} />)}
        </div>
        <div className="text-[11px]" style={{ color: "var(--text3)" }}>{countSubagents ? "Subagent turns are counted" : "Subagent turns are left out"} · window {windowDays} days · cap {cap} per turn</div>
      </div>
      <PreviewNote>Demo numbers; your own tally shows in the Context ledger panel.</PreviewNote>
    </PreviewBox>
  );
}
