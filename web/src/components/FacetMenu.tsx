import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { Avatar } from "./Avatar.tsx";

/**
 * A multi-select facet dropdown, GitHub-style: a pill that opens a checkbox list
 * with a live count beside every option.
 *
 * It is the sibling of Select.tsx and shares its machinery on purpose — the same
 * Portal (so the open list is not clipped by the narrow PR sidebar, nor
 * width-bound by it), the same spring, the same capture-phase key handling so
 * the app's single-letter shortcuts never fire while you are picking. The
 * differences from Select: options toggle instead of pick-and-close (unless
 * `mode="radio"`, used for Sort), each row shows a count, a real search box
 * appears once the list is long, and there is a "Clear" footer.
 */
export interface FacetMenuOption {
  value: string;
  label: string;
  count: number;
  /** A GitHub login, when this option is a person. */
  avatar?: string;
}

export function FacetMenu({
  label, options, selected, onToggle, onClear, mode = "multi", align = "left", note, disabled, pillActive,
}: {
  label: string;
  options: FacetMenuOption[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
  mode?: "multi" | "radio";
  align?: "left" | "right";
  /** A line shown under the list, e.g. "checks still loading". */
  note?: string;
  disabled?: boolean;
  /** Override the pill's "active" styling. Defaults to selected.length > 0;
   *  Sort passes false when on the default so it does not read as a filter. */
  pillActive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, right: 0, minWidth: 0 });

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => o.label.toLowerCase().includes(s) || o.value.toLowerCase().includes(s)) : options;
  }, [q, options]);
  const showSearch = options.length > 12;

  useLayoutEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: r.left, right: window.innerWidth - r.right, minWidth: r.width });
    }
  }, [open]);

  useEffect(() => {
    if (open) { setCursor(0); setQ(""); }
  }, [open]);

  // Keep the highlighted row in view. Focus stays in the search box (or the
  // list) so type-to-filter works the moment the menu opens.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
    if (showSearch) searchRef.current?.focus();
  }, [open, cursor, showSearch]);

  const close = () => { setOpen(false); btnRef.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Capture phase + stopPropagation: the PR list binds j/k and the app binds
      // single letters — neither should fire while this menu is open.
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        e.preventDefault(); e.stopPropagation();
        setCursor((c) => {
          if (e.key === "Home") return 0;
          if (e.key === "End") return filtered.length - 1;
          const d = e.key === "ArrowDown" ? 1 : -1;
          return filtered.length ? (c + d + filtered.length) % filtered.length : 0;
        });
        return;
      }
      if (e.key === "Enter" || (e.key === " " && !showSearch)) {
        e.preventDefault(); e.stopPropagation();
        const o = filtered[cursor];
        if (o) { onToggle(o.value); if (mode === "radio") close(); }
        return;
      }
      // Let the search box receive normal typing; just keep it from reaching the app.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, cursor, filtered, showSearch, mode]);

  const n = selected.length;
  const active = pillActive ?? n > 0;
  const badge = mode === "radio" ? (options.find((o) => o.value === selected[0])?.label ?? selected[0]) : String(n);
  const pill = "text-[10px] px-2 py-0.5 rounded-full shrink-0 flex items-center gap-1 whitespace-nowrap";

  return (
    <>
      <button
        ref={btnRef}
        disabled={disabled}
        onClick={() => !disabled && (open ? close() : setOpen(true))}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className={pill}
        style={{
          color: active ? "var(--bg)" : "var(--text2)",
          background: active ? "var(--primary)" : "transparent",
          border: `1px solid ${active || open ? "var(--primary)" : "color-mix(in srgb, var(--border) 45%, transparent)"}`,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {label}
        {active && <span className="tabular-nums" style={{ opacity: 0.85 }}>{badge}</span>}
        <span className="text-[7px] opacity-70">▼</span>
      </button>
      <Portal>
        <AnimatePresence>
          {open && (
            <>
              <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={close} />
              <motion.div
                initial={{ opacity: 0, y: -8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.96 }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                role="listbox"
                aria-label={label}
                className="fixed p-1.5 rounded-xl flex flex-col overflow-hidden"
                style={{
                  top: pos.top,
                  ...(align === "right" ? { right: pos.right } : { left: pos.left }),
                  minWidth: Math.max(pos.minWidth, 180),
                  maxWidth: 300,
                  maxHeight: "min(60vh, 420px)",
                  zIndex: 9999,
                  background: "color-mix(in srgb, var(--bg2) 97%, black)",
                  border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                  boxShadow: "0 24px 60px -18px rgba(0,0,0,0.7)",
                  backdropFilter: "blur(18px)",
                }}
              >
                {showSearch && (
                  <input
                    ref={searchRef}
                    value={q}
                    onChange={(e) => { setQ(e.target.value); setCursor(0); }}
                    placeholder={`Filter ${label.toLowerCase()}…`}
                    className="text-[11px] px-2 py-1 mb-1 rounded-lg bg-transparent"
                    style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", outline: "none" }}
                  />
                )}
                <div ref={listRef} className="flex flex-col gap-0.5 overflow-y-auto agw-noscrollbar">
                  {filtered.length === 0 ? (
                    <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>No matches</div>
                  ) : filtered.map((o, i) => {
                    const on = selected.includes(o.value);
                    return (
                      <button key={o.value} onClick={() => { onToggle(o.value); if (mode === "radio") close(); }}
                        role="option"
                        aria-selected={on}
                        tabIndex={-1}
                        onMouseEnter={() => setCursor(i)}
                        className="px-2 py-1.5 rounded-lg text-[11.5px] text-left flex items-center gap-2"
                        style={i === cursor ? { background: "color-mix(in srgb, var(--primary) 22%, transparent)" } : undefined}>
                        <span aria-hidden className="shrink-0 grid place-items-center text-[9px]"
                          style={{
                            width: 14, height: 14,
                            borderRadius: mode === "radio" ? 999 : 4,
                            border: `1px solid ${on ? "var(--primary)" : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
                            background: on ? "var(--primary)" : "transparent",
                            color: "var(--bg)",
                          }}>
                          {on ? (mode === "radio" ? "●" : "✓") : ""}
                        </span>
                        {/* The person, when the facet is about people — the face
                            is how you find a name in a list of twelve. */}
                        {o.avatar && <Avatar login={o.avatar} size={16} />}
                        <span className="flex-1 truncate" style={{ color: on ? "var(--text)" : "var(--text2)" }}>{o.label}</span>
                        {/* No count. It could only ever count the page in hand,
                            and the filter searches the whole repository; GitHub
                            shows no number in these menus for the same reason. */}
                      </button>
                    );
                  })}
                </div>
                {note && <div className="px-2.5 pt-1.5 text-[9.5px]" style={{ color: "var(--warning)" }}>{note}</div>}
                {mode === "multi" && n > 0 && (
                  <button onClick={() => { onClear(); }}
                    className="mt-1 px-2.5 py-1 rounded-lg text-[10.5px] text-left hover:bg-white/5"
                    style={{ color: "var(--text3)", borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
                    Clear {label.toLowerCase()}
                  </button>
                )}
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}
