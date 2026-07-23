import { motion, AnimatePresence } from "motion/react";
import type { WatchEvent } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { friendly } from "../lib/labels.ts";
import { fmtTime, fmtMs, fmtUsd, fmtTokens, agentKey, typeColor } from "../lib/format.ts";

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 border-b" style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
      <span className="t-dim2 text-[11px]">{k}</span>
      <span className="text-[11px] text-right tabular-nums" style={{ color: "var(--text2)" }}>{v}</span>
    </div>
  );
}

export function EventModal({ event, onClose }: { event: WatchEvent | null; onClose: () => void }) {
  return (
    <Portal>
      <AnimatePresence>
        {event && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(3px)" }}
              onClick={onClose}
            />
            {/* Flex wrapper centers the card — Motion owns `transform` for its
                scale/y animation, so Tailwind translate centering can't be used. */}
            <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10001 }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ type: "spring", stiffness: 320, damping: 30 }}
              className="w-[min(680px,92vw)] max-h-[82vh] rounded-2xl flex flex-col pointer-events-auto"
              style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}
            >
              <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                <div className="flex items-center gap-2.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: typeColor(event.hook_event_type), boxShadow: `0 0 8px ${typeColor(event.hook_event_type)}` }} />
                  <div>
                    <div className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>{friendly(event).verb}</div>
                    <div className="text-[10px] t-dim2">{event.hook_event_type} · {agentKey(event)}</div>
                  </div>
                </div>
                <button onClick={onClose} className="text-[18px] leading-none px-2 t-dim2 hover:opacity-70">✕</button>
              </div>

              <div className="p-5 overflow-auto">
                <div className="grid grid-cols-2 gap-x-6 mb-4">
                  <Row k="Time" v={fmtTime(event.timestamp)} />
                  <Row k="Tool" v={event.tool_name ?? "—"} />
                  <Row k="Model" v={event.model_name ?? "—"} />
                  <Row k="Duration" v={event.duration_ms != null ? fmtMs(event.duration_ms) : "—"} />
                  <Row k="Cost" v={event.cost_usd > 0 ? fmtUsd(event.cost_usd) : "—"} />
                  <Row k="Tokens" v={event.input_tokens + event.output_tokens > 0 ? `${fmtTokens(event.input_tokens)} in · ${fmtTokens(event.output_tokens)} out` : "—"} />
                  <Row k="Session" v={event.session_id} />
                  <Row k="Error" v={event.is_error ? <span style={{ color: "var(--error)" }}>{event.error_text ?? "Yes"}</span> : "No"} />
                </div>
                <div className="text-[10px] uppercase tracking-wider t-dim2 mb-1">payload</div>
                <pre className="text-[10.5px] leading-relaxed rounded-lg p-3 overflow-auto max-h-[38vh]"
                  style={{ background: "var(--bg)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", color: "var(--text3)" }}>
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </div>
            </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
