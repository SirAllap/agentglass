import { motion, AnimatePresence } from "motion/react";
import type { WatchEvent } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { friendly } from "../lib/labels.ts";
import { fmtTime, fmtMs, fmtUsd, fmtTokens, fmtEq, eqTitle, agentKey, typeColor } from "../lib/format.ts";
import { CloseButton } from "./CloseButton.tsx";

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
    <Portal find>
      <AnimatePresence>
        {event && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 agx-scrim" style={{ zIndex: 10000 }}
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
                <CloseButton onClick={onClose} />
              </div>

              <div className="p-5 overflow-auto">
                <div className="grid grid-cols-2 gap-x-6 mb-4">
                  <Row k="Time" v={fmtTime(event.timestamp)} />
                  <Row k="Tool" v={event.tool_name ?? "—"} />
                  <Row k="Model" v={event.model_name ?? "—"} />
                  <Row k="Duration" v={event.duration_ms != null ? fmtMs(event.duration_ms) : "—"} />
                  <Row k="Cost" v={event.cost_usd > 0 ? fmtUsd(event.cost_usd) : "—"} />
                  {/* All four classes, not two.
                      The old row was `in · out` behind an `input + output > 0`
                      guard, so an event that only read cache rendered as an em
                      dash while carrying real tokens and real cost. This is the
                      breakdown the one number outside is short for, so it shows
                      every class that is non-zero. */}
                  <Row k="Tokens" v={<TokenBreakdown e={event} />} />
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

/**
 * The breakdown, which is the point of being one click deep.
 *
 * The lists outside this modal show a single weighted number, because four
 * numbers cannot be compared or ranked. Here there is room, and the four are
 * what make a cache problem diagnosable — a session whose cache writes rival
 * its reads is re-sending a context it should be hitting.
 */
function TokenBreakdown({ e }: { e: WatchEvent }) {
  const parts: string[] = [];
  if (e.input_tokens) parts.push(`${fmtTokens(e.input_tokens)} in`);
  if (e.output_tokens) parts.push(`${fmtTokens(e.output_tokens)} out`);
  if (e.cache_creation_tokens) parts.push(`${fmtTokens(e.cache_creation_tokens)} cache write`);
  if (e.cache_read_tokens) parts.push(`${fmtTokens(e.cache_read_tokens)} cache read`);
  if (!parts.length) return <>—</>;
  const eq = e.equiv_tokens;
  return (
    <span title={eq == null ? undefined : eqTitle(eq)}>
      {eq == null ? null : <span className="tabular-nums">{fmtEq(eq)} · </span>}
      <span className="t-dim2">{parts.join(" · ")}</span>
    </span>
  );
}
