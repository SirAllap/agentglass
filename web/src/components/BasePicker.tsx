import { useLayoutEffect, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";

/**
 * Pick what a branch is measured and merged against.
 *
 * Git does not record what a branch was cut from, so the app has to work it
 * out: an override, the base its pull request declares, then the shape of
 * history. The first two are exact and the third is a guess — and a guess needs
 * somewhere to be corrected, or a branch measured against the wrong thing stays
 * wrong forever.
 *
 * Reachable even when the branch is level with its base. That is not a detail:
 * a *wrong* base usually reports zero, because the thing it named is one this
 * branch already contains. Hiding the picker behind "there is a gap" hides it
 * in exactly the case you need it — which is what the worktree rows did, where
 * the only affordance lived inside the behind-chip and the behind-chip only
 * appeared when the base was already right.
 *
 * Rendered through a Portal for the same reason `Select` is: the worktree list
 * scrolls and clips, so a list positioned in the normal flow would be cut off
 * by its own container. It flips above the button when there is no room below,
 * because the rows that most need this are the ones at the bottom of a long
 * list.
 */
export type BaseRef = { name: string; remote: boolean };

export function BasePicker({
  branch, base, refs, onOpen, onPick, disabled, label = "▾", title, className, style,
}: {
  branch: string;
  base: string | null;
  refs: BaseRef[];
  /** Called when the menu opens, so the ref list is fetched on demand rather
   *  than by every row on every render. */
  onOpen: () => void;
  onPick: (name: string) => void;
  disabled?: boolean;
  label?: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number; maxHeight: number }>({ right: 0, maxHeight: 320 });

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    // Flip up only when down genuinely does not fit *and* up is roomier —
    // flipping for a few pixels' gain moves the menu somewhere the eye is not.
    const up = below < 220 && above > below;
    setPos({
      top: up ? undefined : r.bottom + 6,
      bottom: up ? window.innerHeight - r.top + 6 : undefined,
      right: Math.max(8, window.innerWidth - r.right),
      maxHeight: Math.max(180, Math.min(340, up ? above : below)),
    });
  }, [open]);

  // Capture phase: the panel binds Escape and single-letter shortcuts (j/k/d),
  // and the list is useless if closing it also closes the panel behind it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const close = () => { setQuery(""); setOpen(false); };

  const shown = refs
    .filter((b) => b.name !== branch)
    .filter((b) => { const q = query.trim().toLowerCase(); return !q || b.name.toLowerCase().includes(q); })
    // The current base first, then the trunk, then the rest as git ordered them
    // (most recent first).
    .sort((a, b) => Number(b.name === base) - Number(a.name === base)
      || Number(/(^|\/)(master|main)$/.test(b.name)) - Number(/(^|\/)(master|main)$/.test(a.name)));

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation(); // rows select on click; opening the menu is not selecting
          if (disabled) return;
          if (open) { close(); return; }
          onOpen();
          setOpen(true);
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={className}
        style={{ ...style, ...(disabled ? { opacity: 0.5 } : null) }}
        title={title ?? (base ? `Measured against ${base} — pick a different base` : "Pick what this branch is measured against")}>
        {label}
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
                className="fixed rounded-xl text-[11px] flex flex-col"
                style={{
                  top: pos.top, bottom: pos.bottom, right: pos.right,
                  minWidth: 300, maxHeight: pos.maxHeight, overflow: "hidden", zIndex: 9999,
                  background: "color-mix(in srgb, var(--bg2) 97%, black)",
                  border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                  boxShadow: "0 24px 60px -18px rgba(0,0,0,0.7)",
                  backdropFilter: "blur(18px)",
                }}>
                <div className="px-2.5 py-1.5 t-dim2 text-[9.5px] uppercase tracking-wider shrink-0 truncate" title={branch}>
                  measure {branch} against…
                </div>
                {/* The base it will actually use, pinned above the search — the
                    answer to "what is this compared to" should not require
                    scrolling a list of 800 to find the highlighted row. */}
                <div className="mx-1.5 mb-1 px-2 py-1.5 rounded-md flex items-center gap-2 shrink-0"
                  style={{ background: "color-mix(in srgb, var(--primary) 15%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
                  <span className="shrink-0" style={{ color: "var(--primary-hover)" }}>✓</span>
                  <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }} title={base ?? ""}>{base ?? "no base"}</span>
                  <span className="shrink-0 text-[10px] t-dim2">current base</span>
                </div>
                <div className="px-2.5 pb-0.5 t-dim2 text-[9.5px] uppercase tracking-wider shrink-0">or change to…</div>
                {/* A real repo has hundreds of refs — this one offers 827 — so
                    the list is only usable with a filter. */}
                <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder="filter branches…"
                  className="mx-1.5 mb-1 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0"
                  style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                <div className="agx-scroll overflow-y-auto pb-1">
                  {/* Clearing the override is how you get back to the app's own
                      answer, which is right far more often than not — without
                      it, one correction pins the branch to a hand-picked base
                      for good. Offered only when there is something to clear:
                      the server treats an empty base as `--unset`, and it reads
                      as a no-op the rest of the time. */}
                  <button onClick={() => { close(); onPick(""); }}
                    className="w-full text-left px-2.5 py-1.5 flex items-center gap-2"
                    style={{ color: "var(--text3)" }}
                    title="Forget the override and go back to the base this app works out on its own">
                    <span className="shrink-0 text-[8.5px] px-1 py-px rounded" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>AUTO</span>
                    <span className="min-w-0 flex-1 truncate">work it out for me</span>
                  </button>
                  {shown.slice(0, 200).map((b) => (
                    <button key={b.name} onClick={() => { close(); onPick(b.name); }}
                      className="w-full text-left px-2.5 py-1.5 flex items-center gap-2"
                      style={{ background: b.name === base ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent", color: "var(--text)" }}
                      title={b.name}>
                      {/* Which kind of ref this is, because it changes what you
                          get: `master` is your copy, which may be weeks behind
                          the `origin/master` next to it. */}
                      <span className="shrink-0 text-[8.5px] px-1 py-px rounded"
                        style={b.remote
                          ? { color: "var(--info)", border: "1px solid color-mix(in srgb, var(--info) 35%, transparent)" }
                          : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
                        {b.remote ? "REMOTE" : "LOCAL"}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{b.name}</span>
                      {b.name === base && <span className="shrink-0 text-[10px]" style={{ color: "var(--primary-hover)" }}>current</span>}
                    </button>
                  ))}
                  {!refs.length && <div className="px-2.5 py-2 t-dim2">loading branches…</div>}
                  {shown.length > 200 && (
                    <div className="px-2.5 py-1.5 t-dim2 text-[9.5px]">showing 200 of {shown.length} — type to find the rest</div>
                  )}
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}
