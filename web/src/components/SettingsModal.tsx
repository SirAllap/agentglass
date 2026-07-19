// Settings — what used to be the "⋯" dropdown.
//
// That menu mixed three unrelated things in one flat list of one-liners:
// preferences you toggle, panels you open, and files you download. Worse, the
// toggles were rendered as their own label ("🔇 Alert sounds — off"), so the
// only way to learn what a click would do was to read the current state and
// invert it in your head — and a stale label read as a broken switch.
//
// Here each kind gets its own section, toggles look like toggles and say what
// they control, and downloads say what you actually get.
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import { autostartEnabled, setAutostart } from "../lib/desktop.ts";
import { MOD_KEY } from "../lib/format.ts";

function Toggle({ on, onClick, label, hint }: { on: boolean; onClick: () => void; label: string; hint: string }) {
  return (
    <button onClick={onClick} role="switch" aria-checked={on}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-white/5">
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>{label}</span>
        <span className="block text-[10.5px] t-dim2 mt-0.5">{hint}</span>
      </span>
      {/* A real switch: position carries the state, so it reads at a glance
          instead of having to be parsed. */}
      <span className="shrink-0 relative rounded-full transition-colors" style={{
        width: 34, height: 19,
        background: on ? "color-mix(in srgb, var(--primary) 55%, transparent)" : "color-mix(in srgb, var(--border) 55%, transparent)",
      }}>
        <span className="absolute rounded-full transition-transform" style={{
          width: 15, height: 15, top: 2, left: 2,
          transform: on ? "translateX(15px)" : "translateX(0)",
          background: on ? "var(--primary-hover)" : "var(--text3)",
        }} />
      </span>
    </button>
  );
}

function Row({ label, hint, kbd, href, download, onClick }: { label: string; hint: string; kbd?: string; href?: string; download?: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>{label}</span>
        <span className="block text-[10.5px] t-dim2 mt-0.5">{hint}</span>
      </span>
      {kbd && <kbd className="chip text-[9.5px] t-dim2 shrink-0">{kbd}</kbd>}
    </>
  );
  const cls = "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-white/5";
  return href
    ? <a href={href} download={download} className={cls}>{body}</a>
    : <button onClick={onClick} className={cls}>{body}</button>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-2 py-2">
      <div className="panel-eyebrow px-3 pb-1">{title}</div>
      {children}
    </div>
  );
}

export function SettingsModal({ open, onClose, sound, onSound, onOpenStats, onOpenHelp }: {
  open: boolean; onClose: () => void; sound: boolean; onSound: () => void; onOpenStats: () => void; onOpenHelp: () => void;
}) {
  // Launch-at-login belongs to the installed app, so the row exists only in the
  // desktop window — and only once the shell has confirmed the current state,
  // rather than showing a switch that might be lying about it.
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  useEffect(() => { if (open) autostartEnabled().then(setAutostartState); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: 8 }}
                transition={{ type: "spring", stiffness: 340, damping: 30 }}
                className="w-[460px] max-w-[95vw] max-h-[85vh] rounded-2xl flex flex-col pointer-events-auto overflow-hidden"
                style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}>

                <div className="flex items-center gap-3 px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>Settings</span>
                  <button onClick={onClose} className="ml-auto text-[18px] leading-none px-2 t-dim2 hover:opacity-70">✕</button>
                </div>

                <div className="overflow-y-auto flex-1 divide-y" style={{ borderColor: "color-mix(in srgb, var(--border) 20%, transparent)" }}>
                  <Section title="Preferences">
                    <Toggle on={sound} onClick={onSound}
                      label="Alert sounds"
                      hint="A chime when a session errors or needs you" />
                    {autostart !== null && (
                      <Toggle on={autostart} onClick={async () => {
                        const next = await setAutostart(!autostart);
                        if (next !== null) setAutostartState(next);
                      }}
                        label="Start at login"
                        hint="Open agentglass automatically when you log in" />
                    )}
                  </Section>

                  <Section title="Open">
                    <Row label="Statistics" hint="Totals, tool latency and cost breakdowns" kbd="s"
                      onClick={() => { onOpenStats(); onClose(); }} />
                    <Row label="Legend & shortcuts" hint="What the colours mean, and every key binding" kbd="?"
                      onClick={() => { onOpenHelp(); onClose(); }} />
                    <Row label="Command palette" hint="Jump to any panel, filter or session" kbd={`${MOD_KEY}K`}
                      onClick={onClose} />
                  </Section>

                  <Section title="Export">
                    {/* Scoped like everything else: with a project open these
                        carry that project's rows, not the whole machine's. */}
                    <Row label="Events — CSV" hint="One row per event, for a spreadsheet"
                      href={api.exportUrl("csv")} download="agentglass-events.csv" />
                    <Row label="Events — JSON" hint="Full payloads, for scripting"
                      href={api.exportUrl("json")} download="agentglass-events.json" />
                    <Row label="Skills catalog — Markdown" hint="Every skill the fleet has available"
                      href={api.skillsExportUrl()} download="agentglass-skills.md" />
                  </Section>
                </div>
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
