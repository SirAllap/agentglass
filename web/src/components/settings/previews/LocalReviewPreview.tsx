import { StatusBadge } from "../../SettingsKit.tsx";
import { PreviewBox, PreviewNote } from "./Frame.tsx";

export interface LocalReviewPreviewProps {
  /** Display name of the CLI that reads the pull request. */
  agent: string;
  model: string;
  /** Spend cap per review, USD. */
  capUsd: number;
}

const FINDINGS: [string, string, string][] = [
  ["high", "502 from the proxy is retried, 502 from the app is not", "client.ts:142"],
  ["med", "No test covers the ceiling of 1", "retry.test.ts"],
  ["low", "delivery and attempt are the same thing under two names", "queue.ts:8"],
];
const TONE: Record<string, string> = { high: "--error", med: "--warning", low: "--info" };

/** A local review as the plugin shows it, on an invented pull request: who reads, with which model, under which cap. */
export function LocalReviewPreview({ agent, model, capUsd }: LocalReviewPreviewProps) {
  return (
    <PreviewBox label="Local review">
      <div data-preview="local-review" className="rounded-lg p-4 flex flex-col gap-2 min-w-0" style={{ background: "var(--bg)" }}>
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <b style={{ color: "var(--text)" }}>Local review</b>
          <span data-who style={{ color: "var(--text3)" }}>{agent} · {model}</span>
          <span className="flex-1" />
          <StatusBadge tone="ok">sandbox: no writes, no network</StatusBadge>
        </div>
        {FINDINGS.map(([sev, text, where]) => (
          <div key={where} className="flex items-baseline gap-2 text-[12px] min-w-0 rounded-md px-2 py-1.5" style={{ background: `color-mix(in srgb, var(${TONE[sev]}) 9%, transparent)` }}>
            <b className="text-[10px] uppercase shrink-0" style={{ color: `var(${TONE[sev]}-ink)` }}>{sev}</b>
            <span className="flex-1 min-w-0" style={{ color: "var(--text)" }}>{text}</span>
            <small className="shrink-0" style={{ color: "var(--text3)" }}>{where}</small>
          </div>
        ))}
        <div className="text-[11px]" style={{ color: "var(--text3)" }}>Cap per review: ${capUsd.toFixed(2)}. Nothing is posted to GitHub.</div>
      </div>
      <PreviewNote>An invented review; yours appears on a pull request.</PreviewNote>
    </PreviewBox>
  );
}
