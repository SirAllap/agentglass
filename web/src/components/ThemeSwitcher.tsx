import { useRef, useState, useLayoutEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { THEMES, pickTheme, type Theme } from "../lib/themes.ts";
import { Portal } from "./Portal.tsx";

// Group themes by the luminance of their background — no per-theme flag needed.
function isDark(t: Theme): boolean {
  const hex = (t.vars["--bg"] ?? "#000").replace("#", "");
  const n = parseInt(hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}
const GROUPS: { label: string; themes: Theme[] }[] = [
  { label: "dark", themes: THEMES.filter(isDark) },
  { label: "light", themes: THEMES.filter((t) => !isDark(t)) },
];

export function ThemeSwitcher({ current, onChange }: { current: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const active = THEMES.find((t) => t.id === current) ?? THEMES[0];

  useLayoutEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 8, right: window.innerWidth - r.right });
    }
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className="h-8 flex items-center gap-2 px-2.5 rounded-lg text-[11px]"
        style={{ border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", background: "color-mix(in srgb, var(--bg3) 30%, transparent)" }}
      >
        <span className="flex -space-x-1">
          {[active.preview.primary, active.preview.secondary, active.preview.accent].map((c, i) => (
            <span key={i} className="h-3 w-3 rounded-full ring-1 ring-black/30" style={{ background: c }} />
          ))}
        </span>
        <span className="t-dim hidden xl:inline">{active.name}</span>
        <span className="t-dim2">▾</span>
      </button>

      <Portal>
        <AnimatePresence>
          {open && (
            <>
              <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={() => setOpen(false)} />
              <motion.div
                initial={{ opacity: 0, y: -8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.96 }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="fixed w-[440px] max-w-[92vw] p-2 rounded-xl overflow-y-auto"
                style={{
                  top: pos.top,
                  right: pos.right,
                  maxHeight: "min(72vh, 640px)",
                  zIndex: 9999,
                  background: "color-mix(in srgb, var(--bg2) 97%, black)",
                  border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                  boxShadow: "0 24px 60px -18px rgba(0,0,0,0.7)",
                  backdropFilter: "blur(18px)",
                }}
              >
                {GROUPS.map((g) => (
                  <div key={g.label}>
                    <div className="px-1 pt-1.5 pb-1 text-[9px] uppercase tracking-[0.18em] t-dim2">{g.label}</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {g.themes.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => {
                            pickTheme(t.id);
                            onChange(t.id);
                            setOpen(false);
                          }}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[10.5px] text-left transition-transform hover:scale-[1.03]"
                          style={{
                            background: t.id === current ? "color-mix(in srgb, var(--primary) 20%, transparent)" : "color-mix(in srgb, var(--bg3) 30%, transparent)",
                            border: `1px solid ${t.id === current ? "var(--primary)" : "transparent"}`,
                          }}
                        >
                          <span className="flex -space-x-1 shrink-0">
                            {[t.preview.primary, t.preview.secondary, t.preview.accent].map((c, i) => (
                              <span key={i} className="h-3 w-3 rounded-full ring-1 ring-black/40" style={{ background: c }} />
                            ))}
                          </span>
                          <span className="whitespace-nowrap t-dim">{t.name}</span>
                          {t.id === current && <span className="ml-auto shrink-0" style={{ color: "var(--primary-hover)" }}>✓</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}
