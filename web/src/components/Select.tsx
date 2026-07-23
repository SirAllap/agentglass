import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";

/**
 * A themed replacement for a native <select>.
 *
 * The browser draws a real select's option list itself, in system colours and
 * system font. It ignores the theme completely, so a bright OS panel lands in
 * the middle of a dark cockpit, and no CSS reliably reaches inside it. Drawing
 * the list ourselves is the only way to make it match — and it gets the same
 * portal-and-spring treatment as the rest of the app's popups, so every menu
 * behaves alike.
 *
 * Rendered through a Portal because these sit inside panels that clip and
 * scroll; a list positioned in the normal flow would be cut off by its own
 * container.
 */
export type SelectOption = { value: string; label: string; hint?: string };

export function Select({
  value, options, onChange, disabled, title, className, style, placeholder, align = "left",
}: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
  /** Shown when `value` matches no option (e.g. an "all" state). */
  placeholder?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, right: 0, minWidth: 0 });
  // Replacing a native <select> means re-implementing everything it gave for
  // free. `cursor` is the roving highlight; `typed` backs type-ahead, which is
  // how anyone picks from a long list without reaching for the mouse.
  const [cursor, setCursor] = useState(0);
  const typed = useRef({ buf: "", at: 0 });

  useLayoutEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: r.left, right: window.innerWidth - r.right, minWidth: r.width });
    }
  }, [open]);

  // Open on the current value, so ↑/↓ start from where the user already is.
  useEffect(() => {
    if (open) setCursor(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open, value, options]);

  // Keep the highlighted option in view and focused, so a screen reader
  // announces it and long lists scroll as you move.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
    el?.focus({ preventScroll: true });
  }, [open, cursor]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Capture phase: panels bind their own Escape-to-close, and the app binds
      // single-letter shortcuts (d/g/o/t/c) that would otherwise fire while the
      // user is typing to search this list.
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Enter" || e.key === " ") { pick(options[cursor]?.value ?? value); return; }
        setCursor((c) => {
          if (e.key === "Home") return 0;
          if (e.key === "End") return options.length - 1;
          const d = e.key === "ArrowDown" ? 1 : -1;
          return (c + d + options.length) % options.length;
        });
        return;
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.stopPropagation();
        const now = Date.now();
        typed.current.buf = now - typed.current.at > 800 ? e.key : typed.current.buf + e.key;
        typed.current.at = now;
        const q = typed.current.buf.toLowerCase();
        const i = options.findIndex((o) => o.label.toLowerCase().startsWith(q));
        if (i >= 0) setCursor(i);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, cursor, options, value]);

  const current = options.find((o) => o.value === value);
  // Focus goes back where it came from, or it lands on <body> and a keyboard
  // user has to tab in from the top of the page again.
  const close = () => { setOpen(false); btnRef.current?.focus(); };
  const pick = (v: string) => { onChange(v); close(); };

  return (
    <>
      <button
        ref={btnRef}
        title={title}
        disabled={disabled}
        onClick={() => !disabled && (open ? close() : setOpen(true))}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={title}
        className={`${className ?? "rounded-lg px-2 py-1 text-[11px] outline-none max-w-[160px]"} shrink-0 flex items-center gap-1 ${disabled ? "opacity-60 cursor-default" : ""}`}
        style={{ ...style, ...(open ? { borderColor: "color-mix(in srgb, var(--primary) 55%, transparent)" } : null) }}
      >
        <span className="truncate">{current?.label ?? placeholder ?? value}</span>
        <span className="text-[8px] shrink-0 opacity-70">▼</span>
      </button>
      <Portal>
        <AnimatePresence>
          {open && (
            <>
              <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={close} />
              <motion.div
                initial={{ opacity: 0, y: -8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.96 }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                ref={listRef}
                role="listbox"
                aria-label={title ?? "Options"}
                className="fixed p-1.5 rounded-xl flex flex-col gap-0.5 overflow-y-auto agw-noscrollbar"
                style={{
                  top: pos.top,
                  ...(align === "right" ? { right: pos.right } : { left: pos.left }),
                  minWidth: Math.max(pos.minWidth, 140),
                  maxHeight: "min(60vh, 420px)",
                  zIndex: 9999,
                  background: "color-mix(in srgb, var(--bg2) 97%, black)",
                  border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                  boxShadow: "0 24px 60px -18px rgba(0,0,0,0.7)",
                  backdropFilter: "blur(18px)",
                }}
              >
                {options.map((o, i) => (
                  <button key={o.value} onClick={() => pick(o.value)}
                    role="option"
                    aria-selected={o.value === value}
                    tabIndex={-1}
                    onMouseEnter={() => setCursor(i)}
                    className="px-2.5 py-1.5 rounded-lg text-[11.5px] text-left whitespace-nowrap hover:bg-white/5 flex items-center gap-3"
                    style={i === cursor
                      ? { background: "color-mix(in srgb, var(--primary) 26%, transparent)", color: "var(--primary-hover)" }
                      : o.value === value
                      ? { background: "color-mix(in srgb, var(--primary) 20%, transparent)", color: "var(--primary-hover)" }
                      : { color: "var(--text3)" }}>
                    <span className="flex-1">{o.label}</span>
                    {o.hint && <span className="text-[9.5px] opacity-60">{o.hint}</span>}
                  </button>
                ))}
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}
