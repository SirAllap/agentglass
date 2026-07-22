import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { WorktreeLeftovers, LeftoverEntry } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { preselected, fmtBytes } from "../lib/goneCleanup.ts";

/**
 * The last thing between somebody's notes and `rm -rf`.
 *
 * Removing a worktree deletes its gitignored files with no --force and no
 * warning, so the branches panel has to name them before it acts. Naming them
 * was step one and it worked — but it left the user copying paths out by hand,
 * which is a step people skip at exactly the moment they shouldn't. This turns
 * the warning into an offer: tick what to keep, it goes into the MAIN checkout
 * at the same relative path, then the worktree goes.
 *
 * The main checkout rather than an archive folder, because that is where these
 * files already live — this repo's `.specs/` in the main checkout holds 157 of
 * exactly these notes, and a worktree's three are the ones that never came
 * back. Anything already there is refused, never overwritten (rescueLeftovers).
 *
 * Keyboard first, like the rest of this panel: j/k to move, space to toggle,
 * a/n for all/none, enter to go. No entry is ticked by default unless copying
 * it is provably safe — see preselected().
 */

const groupOf = (p: string) => p.split("/").pop() || p;

function Tick({ on, dim }: { on: boolean; dim?: boolean }) {
  return (
    <span
      className="shrink-0 w-3.5 h-3.5 rounded flex items-center justify-center text-[9px] leading-none"
      style={{
        color: on ? "var(--bg)" : "transparent",
        background: on ? (dim ? "var(--warning)" : "var(--primary)") : "transparent",
        border: `1px solid ${on ? (dim ? "var(--warning)" : "var(--primary)") : "color-mix(in srgb, var(--border) 60%, transparent)"}`,
      }}
    >{on ? "✓" : ""}</span>
  );
}

/** A flat row list across every worktree, so j/k crosses group boundaries the
 *  way a single list should. Headers are rendered from the same array. */
type Row = { kind: "head"; report: WorktreeLeftovers } | { kind: "entry"; report: WorktreeLeftovers; entry: LeftoverEntry };
const keyOf = (r: WorktreeLeftovers, e: LeftoverEntry) => `${r.path}\u0000${e.path}`;

export function RescueModal({ reports, onCancel, onConfirm }: {
  reports: WorktreeLeftovers[];
  onCancel: () => void;
  /** Chosen paths per worktree path. Empty map means "remove, rescue nothing". */
  onConfirm: (picked: Map<string, string[]>) => void;
}) {
  const [on, setOn] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const r of reports) for (const p of preselected(r)) s.add(`${r.path}\u0000${p}`);
    return s;
  });
  const [cur, setCur] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const report of reports) {
      out.push({ kind: "head", report });
      for (const entry of report.entries) out.push({ kind: "entry", report, entry });
    }
    return out;
  }, [reports]);
  const selectable = useMemo(() => rows.map((r, i) => (r.kind === "entry" ? i : -1)).filter((i) => i >= 0), [rows]);

  // Land on the first real row, never on a header.
  useEffect(() => { if (selectable.length && !selectable.includes(cur)) setCur(selectable[0]!); }, [selectable, cur]);

  const totals = useMemo(() => {
    let bytes = 0, n = 0, overwriteless = 0;
    for (const r of rows) {
      if (r.kind !== "entry") continue;
      if (!on.has(keyOf(r.report, r.entry))) continue;
      n++; bytes += Math.max(0, r.entry.bytes);
      if (r.entry.vsMain === "differs") overwriteless++;
    }
    return { bytes, n, differs: overwriteless };
  }, [rows, on]);

  const toggle = (k: string) => setOn((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const confirm = () => {
    const picked = new Map<string, string[]>();
    for (const r of rows) {
      if (r.kind !== "entry" || !on.has(keyOf(r.report, r.entry))) continue;
      picked.set(r.report.path, [...(picked.get(r.report.path) ?? []), r.entry.path]);
    }
    onConfirm(picked);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
      if (e.key === "Enter") { e.preventDefault(); confirm(); return; }
      const at = selectable.indexOf(cur);
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setCur(selectable[Math.min(selectable.length - 1, at + 1)] ?? cur); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setCur(selectable[Math.max(0, at - 1)] ?? cur); }
      else if (e.key === " ") { e.preventDefault(); const r = rows[cur]; if (r?.kind === "entry") toggle(keyOf(r.report, r.entry)); }
      // "all" means all, including the ones that would overwrite — it is an
      // explicit keystroke, and the count of those is shown in the footer.
      else if (e.key === "a") { e.preventDefault(); setOn(new Set(rows.flatMap((r) => (r.kind === "entry" ? [keyOf(r.report, r.entry)] : [])))); }
      else if (e.key === "n") { e.preventDefault(); setOn(new Set()); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rows, selectable, cur, on]);

  useEffect(() => { listRef.current?.querySelector('[data-cur="1"]')?.scrollIntoView({ block: "nearest" }); }, [cur]);

  const nothingToOffer = rows.every((r) => r.kind !== "entry");

  return (
    <Portal>
      <AnimatePresence>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0" style={{ zIndex: 10002, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={onCancel} />
        <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10003 }}>
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }}
            className="pointer-events-auto w-full max-w-[760px] max-h-[80vh] flex flex-col rounded-xl overflow-hidden"
            style={{ background: "var(--bg2)", border: "1px solid var(--border)", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
          >
            <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="text-[13px] font-medium" style={{ color: "var(--text)" }}>
                Keep anything before removing {reports.length} worktree{reports.length === 1 ? "" : "s"}?
              </div>
              <div className="text-[11px] mt-1" style={{ color: "var(--text3)" }}>
                Ticked files are copied into the main checkout at the same path, then the worktrees are removed.
                Nothing already there is overwritten.
              </div>
            </div>

            <div ref={listRef} className="agx-scroll overflow-y-auto flex-1 px-2 py-2">
              {nothingToOffer && (
                <div className="px-3 py-6 text-[11.5px] text-center" style={{ color: "var(--text3)" }}>
                  Nothing unique in these checkouts — everything in them is either a cache or already in the main checkout.
                </div>
              )}
              {rows.map((r, i) => r.kind === "head" ? (
                <div key={`h${i}`} className="px-2 pt-3 pb-1 text-[11px] font-medium flex items-baseline gap-2" style={{ color: "var(--text2)" }}>
                  <span>{groupOf(r.report.path)}</span>
                  <span className="text-[10px]" style={{ color: "var(--text3)" }}>
                    {r.report.identical > 0 && `${r.report.identical} already in the main checkout`}
                    {r.report.identical > 0 && r.report.skipped > 0 && " · "}
                    {r.report.skipped > 0 && `${r.report.skipped} rebuildable`}
                    {r.report.more > 0 && ` · ${r.report.more} more not shown`}
                  </span>
                </div>
              ) : (
                (() => {
                  const k = keyOf(r.report, r.entry);
                  const ticked = on.has(k);
                  const risky = r.entry.vsMain === "differs";
                  return (
                    <button key={k} data-cur={i === cur ? "1" : undefined} onClick={() => { setCur(i); toggle(k); }}
                      className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-left"
                      style={{ background: i === cur ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "transparent" }}>
                      <Tick on={ticked} dim={risky} />
                      <span className="text-[11.5px] truncate" style={{ color: ticked ? "var(--text)" : "var(--text3)" }}>{r.entry.path}</span>
                      {risky && (
                        <span className="text-[9px] px-1 rounded shrink-0" style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 15%, transparent)" }}>
                          overwrites the main checkout
                        </span>
                      )}
                      <span className="ml-auto text-[10px] tabular-nums shrink-0" style={{ color: "var(--text3)" }}>{fmtBytes(r.entry.bytes)}</span>
                    </button>
                  );
                })()
              ))}
            </div>

            <div className="px-4 py-2.5 flex items-center gap-3" style={{ borderTop: "1px solid var(--border)" }}>
              <span className="text-[11px]" style={{ color: "var(--text3)" }}>
                <span className="t-dim2">j/k</span> move · <span className="t-dim2">space</span> toggle · <span className="t-dim2">a</span> all · <span className="t-dim2">n</span> none
              </span>
              <span className="ml-auto text-[11px] tabular-nums" style={{ color: totals.differs ? "var(--warning)" : "var(--text2)" }}>
                {totals.n} selected · {fmtBytes(totals.bytes)}
                {totals.differs > 0 && ` · ${totals.differs} would overwrite`}
              </span>
              <button onClick={onCancel} className="text-[11px] px-2.5 py-1 rounded" style={{ color: "var(--text2)", border: "1px solid var(--border)" }}>Cancel</button>
              <button onClick={confirm} className="text-[11px] px-2.5 py-1 rounded font-medium" style={{ color: "var(--bg)", background: "var(--primary)" }}>
                {totals.n ? `Keep ${totals.n} & remove` : "Remove, keep nothing"}
              </button>
            </div>
          </motion.div>
        </div>
      </AnimatePresence>
    </Portal>
  );
}
