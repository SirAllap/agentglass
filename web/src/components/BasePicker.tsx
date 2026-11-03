import { useLayoutEffect, useEffect, useRef, useState } from "react";
import { useCloseWithOwner } from "../lib/layerOwner.ts";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { BranchIcon, DoneIcon, SearchIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { pickerBody } from "../lib/gitDialog.ts";
import { ICON } from "../lib/iconSize.ts";
import { Button, EDGE, LINE, INPUT, INPUT_STYLE, ListRow } from "./workspace/Chrome.tsx";

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
  branch, base, refs, onOpen, onPick, disabled, label = "▾", title, className, style, error, onRetry,
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
  /** The ref list could not be read: said in a sentence, with a way to retry. */
  error?: string | null;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  useCloseWithOwner(() => setOpen(false), { open, from: btnRef });
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

  const isTrunk = (n: string) => /(^|\/)(master|main)$/.test(n);
  const candidates = refs.filter((b) => b.name !== branch);
  const shown = candidates
    .filter((b) => { const q = query.trim().toLowerCase(); return !q || b.name.toLowerCase().includes(q); })
    // The current base first, then the trunk, then the rest as git ordered them
    // (most recent first).
    .sort((a, b) => Number(b.name === base) - Number(a.name === base)
      || Number(isTrunk(b.name)) - Number(isTrunk(a.name)));
  const body = pickerBody({ loading: !refs.length, error, total: candidates.length, shown: shown.length, query });

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
                  width: 360, maxWidth: "calc(100vw - 16px)", maxHeight: pos.maxHeight, overflow: "hidden", zIndex: 9999,
                  background: "var(--surface-card)",
                  border: EDGE,
                  boxShadow: "0 24px 60px -18px rgba(0,0,0,0.7)",
                }}>
                <div className="px-3 pt-2.5 pb-1.5 shrink-0 truncate text-[11.5px]" style={{ color: "var(--text3)" }} title={branch}>
                  Measure <span className="font-mono" style={{ color: "var(--text2)" }}>{branch}</span> against…
                </div>
                {/* A real repo has hundreds of refs — this one offers 827 — so
                    the list is only usable with a filter. */}
                <div className="mx-2.5 mb-2 shrink-0 relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--text3)" }}><SearchIcon size={ICON.sm} /></span>
                  <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
                    placeholder="Find a branch" aria-label="Find a branch"
                    className={`w-full pl-8 pr-16 ${INPUT}`} style={INPUT_STYLE} />
                  {body === "rows" && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 tabular-nums text-[10.5px]" style={{ color: "var(--text3)", fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{shown.length} of {candidates.length}</span>}
                </div>
                <div className="agx-scroll overflow-y-auto overflow-x-hidden px-1 pb-1.5 min-h-0">
                  {body === "loading" && (
                    <div role="status" aria-label="Reading branches" className="px-2.5 flex flex-col gap-1.5">
                      {[0, 1, 2].map((i) => <div key={i} className="rounded-lg motion-safe:animate-pulse" style={{ height: 38, background: "var(--surface-inset)", opacity: 1 - i * 0.2 }} />)}
                    </div>
                  )}
                  {body === "error" && (
                    <div role="alert" className="mx-2.5 flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[12px]" style={{ color: "var(--error-ink)", background: "color-mix(in srgb, var(--error) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 28%, transparent)" }}>
                      <WarningIcon size={ICON.md} /><span className="min-w-0 flex-1">{error}</span>
                      {onRetry && <Button size="compact" onClick={onRetry} className="shrink-0">Try again</Button>}
                    </div>
                  )}
                  {body === "empty" && <div className="px-3 py-4 text-[12px] text-center" style={{ color: "var(--text3)" }}>There is no other branch to measure against.</div>}
                  {body === "no-match" && (
                    <div className="px-3 py-4 text-center text-[12px]" style={{ color: "var(--text3)" }}>
                      <div className="font-medium break-all" style={{ color: "var(--text2)" }}>No branch called “{query.trim()}”</div>
                      <div className="mt-0.5">Check the spelling, or clear the search to see every ref.</div>
                    </div>
                  )}
                  {body === "rows" && shown.slice(0, 200).map((b) => {
                    const on = b.name === base;
                    return (
                      <ListRow key={b.name} onClick={() => { close(); onPick(b.name); }}
                        current={on} title={b.name}
                        leading={
                          <span className="grid place-items-center rounded-lg"
                            style={{ width: 28, height: 28, background: "var(--surface-inset)", border: EDGE, color: b.remote ? "var(--info-ink)" : "var(--text2)" }}>
                            <BranchIcon size={ICON.sm} />
                          </span>
                        }
                        sub={<>{b.remote ? "remote" : "local"}{isTrunk(b.name) ? " · trunk" : ""}</>}
                        trailing={on ? <span className="grid place-items-center rounded-full" style={{ width: 18, height: 18, background: "var(--primary)", color: "var(--on-primary)" }} title="current base"><DoneIcon size={ICON.xs} /></span> : null}>
                        <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{b.name}</span>
                      </ListRow>
                    );
                  })}
                  {body === "rows" && shown.length > 200 && (
                    <div className="px-3 py-1.5 text-[10.5px]" style={{ color: "var(--text3)" }}>showing 200 of {shown.length} — type to find the rest</div>
                  )}
                </div>
                {/* Clearing the override is how you get back to the app's own
                    answer, which is right far more often than not — without
                    it, one correction pins the branch to a hand-picked base
                    for good. The server treats an empty base as `--unset`. */}
                <div className="shrink-0 flex items-center gap-2 px-2.5" style={{ minHeight: 40, borderTop: LINE, background: "var(--surface-nav)" }}>
                  <Button onClick={() => { close(); onPick(""); }} className="shrink-0"
                    title="Forget the override and go back to the base this app works out on its own">Work it out for me</Button>
                  <span className="min-w-0 flex-1 truncate text-right text-[10.5px]" style={{ color: "var(--text3)" }} title={base ?? ""}>
                    {base ? <>now <span className="font-mono">{base}</span></> : "no base set"}
                  </span>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}
