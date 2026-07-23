import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { MOD_KEY } from "../lib/format.ts";
import { IS_DESKTOP } from "../lib/desktop.ts";

const EVENTS: [string, string][] = [
  ["Running a tool", "#a78bfa"],
  ["Tool finished", "#34d399"],
  ["Tool failed", "#f87171"],
  ["Needs your approval", "#fbbf24"],
  ["Session started / ended", "#94a3b8"],
  ["Subagent activity", "#a3e635"],
];
const STATUS: [string, string][] = [
  ["Working", "#34d399"],
  ["Waiting on you", "#fbbf24"],
  ["Errored", "#f87171"],
  ["Idle", "#64748b"],
];

export function HelpLegend({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)" }} onClick={onClose} />
            {/* Flex wrapper centers the card — Motion owns `transform` for its
                scale/y animation, so Tailwind translate centering can't be used. */}
            <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10001 }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 340, damping: 30 }}
              className="w-[min(460px,92vw)] rounded-2xl p-5 pointer-events-auto"
              style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>Legend & shortcuts</span>
                <button onClick={onClose} className="t-dim2 text-[16px] px-2 hover:opacity-70">✕</button>
              </div>
              <div className="grid grid-cols-2 gap-5">
                <div>
                  <div className="panel-eyebrow mb-2">event types</div>
                  {EVENTS.map(([l, c]) => (
                    <div key={l} className="flex items-center gap-2 text-[11px] py-0.5 t-dim">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />{l}
                    </div>
                  ))}
                </div>
                <div>
                  <div className="panel-eyebrow mb-2">agent status</div>
                  {STATUS.map(([l, c]) => (
                    <div key={l} className="flex items-center gap-2 text-[11px] py-0.5 t-dim">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />{l}
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-4 pt-3 border-t" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                <div className="panel-eyebrow mb-2">shortcuts & tips</div>
                <div className="grid grid-cols-2 gap-y-1 text-[11px] t-dim">
                  <span><kbd className="chip">{MOD_KEY}K</kbd> Command palette</span>
                  <span><kbd className="chip">?</kbd> This help</span>
                  <span><kbd className="chip">s</kbd> Statistics</span>
                  <span><kbd className="chip">k</kbd> Skills explorer</span>
                  <span><kbd className="chip">/</kbd> Search all history</span>
                  {IS_DESKTOP && (
                    <span><kbd className="chip">{MOD_KEY}+</kbd> <kbd className="chip">{MOD_KEY}−</kbd> Display size</span>
                  )}
                  <span>Click an event → full details</span>
                  <span>Click an agent → filter to it</span>
                </div>
                <div className="panel-eyebrow mt-3 mb-2">workspace</div>
                <div className="grid grid-cols-2 gap-y-1 text-[11px] t-dim">
                  <span><kbd className="chip">{MOD_KEY}\</kbd> Open / close</span>
                  <span><kbd className="chip">{MOD_KEY}1</kbd>…<kbd className="chip">{MOD_KEY}5</kbd> Jump to a view</span>
                  <span><kbd className="chip">g</kbd> Git</span>
                  <span><kbd className="chip">d</kbd> Diff</span>
                  <span><kbd className="chip">o</kbd> Docker</span>
                  <span><kbd className="chip">t</kbd> Terminal</span>
                  <span><kbd className="chip">c</kbd> Chat</span>
                  <span><kbd className="chip">{MOD_KEY}[</kbd> <kbd className="chip">{MOD_KEY}]</kbd> Cycle views</span>
                  {/* The distinction that actually bites: bare letters are
                      swallowed by the shell and the composer, the ⌘ pair never
                      is. */}
                  <span className="col-span-2 t-dim2">Letters switch views unless you're typing; {MOD_KEY} shortcuts always work</span>
                </div>
              </div>
            </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
