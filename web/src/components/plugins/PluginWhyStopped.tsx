import { useEffect, useRef, useState } from "react";
import type { PublicPlugin } from "../../../../shared/types.ts";
import { stopReason } from "../../lib/pluginStopped.ts";

/**
 * Why a plugin that was switched on is not running, when it died within
 * seconds and the host kept the reason: how it ended and the last lines it
 * wrote to stderr. Closed by default; the row it sits in is the frame.
 */
export function PluginWhyStopped({ plugin }: { plugin: Pick<PublicPlugin, "lastExit" | "lastBoxFailure"> }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const why = stopReason(plugin);
  if (!why) return null;
  const text = [why.headline, why.detail].filter(Boolean).join("\n\n");
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    }, () => { /* no clipboard */ });
  };
  return (
    <details className="min-w-0 text-[12px]" style={{ color: "var(--text2)" }}>
      <summary className="cursor-pointer select-none font-medium" style={{ color: "var(--text)" }}>Why it stopped</summary>
      <div className="mt-1.5 flex flex-col gap-1.5">
        <p className="m-0 leading-relaxed">{why.headline}</p>
        {why.detail && (
          <div className="relative min-w-0">
            <pre className="t-mono m-0 px-2 py-1.5 pr-16 rounded-md text-[11.5px] leading-snug whitespace-pre-wrap break-all overflow-auto max-h-40"
              style={{ color: "var(--text)", background: "var(--surface-inset)" }}>{why.detail}</pre>
            <button type="button" onClick={copy} className="absolute top-1 right-1 text-[10.5px] px-2 min-h-[24px] rounded-md"
              style={{ color: "var(--text2)", background: "var(--surface-card)" }}>{copied ? "Copied" : "Copy"}</button>
          </div>
        )}
      </div>
    </details>
  );
}
