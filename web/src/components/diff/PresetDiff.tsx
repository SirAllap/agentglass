/*
 * A changeset somebody hands you: one commit from the log, or everything one
 * session wrote.
 *
 * Deliberately NOT the Diff view with a prop. The Diff view asks git what has
 * changed across every checkout, on a refresh, with modes and grouping and a
 * filter; this shows a fixed list that is already in hand and will not change
 * while it is open. The old code was both at once, and the seams showed: the
 * Working/Committed switch was drawn here but wired to an effect that returned
 * early on a preset, so both buttons did nothing; the repo list was only
 * fetched on the other path, so every file landed in a section called "Outside
 * any worktree"; and opening a commit while the view happened to be left on
 * "Committed" showed "No file changes captured yet" over a changeset that was
 * sitting right there in a prop.
 *
 * So this one does the one thing: list the files, show the diff of the one that
 * is selected.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { FileChange } from "../../../../shared/types.ts";
import { Portal } from "../Portal.tsx";
import { CloseButton } from "../CloseButton.tsx";
import { SidebarGrip } from "../SidebarGrip.tsx";
import { useSidebarWidth } from "../../lib/sidebarWidth.ts";
import { useDiffHighlight, HiliteCtx } from "../../lib/diffHighlight.ts";
import { diffSplit, diffWrap, setDiffSplit, setDiffWrap } from "../../lib/diffPrefs.ts";
import { useIncremental } from "../../lib/useIncremental.ts";
import { ICON } from "../../lib/iconSize.ts";
import { SplitDiff, UnifiedDiff, SCROLLBAR_CSS, SPLIT_SEL_CSS } from "./DiffLines.tsx";
import { ThemePicker, Toggle } from "./DiffControls.tsx";

export type PresetDiffProps = {
  open: boolean;
  onClose: () => void;
  /** The changeset. Fixed for as long as this is open. */
  changes: FileChange[];
  title?: string;
  /** Which file to open on — the one the caller was pointing at. */
  path?: string;
  onBack?: () => void;
  backLabel?: string;
};

export function PresetDiff({ open, onClose, changes, title, path, onBack, backLabel }: PresetDiffProps) {
  return (
    <Portal find>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 agx-scrim" style={{ zIndex: 10000 }} onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center p-3 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 14 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ type: "spring", stiffness: 330, damping: 30 }}
                className="w-[95vw] h-[95vh] rounded-2xl flex flex-col pointer-events-auto outline-none overflow-hidden"
                style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}
              >
                <Inner changes={changes} title={title} path={path} onBack={onBack} backLabel={backLabel} onClose={onClose} />
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}

function Inner({ changes, title, path, onBack, backLabel, onClose }: Omit<PresetDiffProps, "open">) {
  const sidebarW = useSidebarWidth();
  const [selId, setSelId] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [split, setSplit] = useState(diffSplit);
  const [wrap, setWrap] = useState(diffWrap);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? changes.filter((c) => c.file_path.toLowerCase().includes(s)) : changes;
  }, [changes, q]);

  // Open on the file the caller pointed at, or the first one. Runs on the
  // changeset rather than on mount: the same modal is reused for the next commit
  // in the log, and a stale id there shows the wrong file's diff.
  useEffect(() => {
    const wanted = path ? changes.find((c) => c.file_path === path) : null;
    setSelId((wanted ?? changes[0])?.id ?? null);
  }, [changes, path]);

  const selected = useMemo(() => shown.find((c) => c.id === selId) ?? shown[0] ?? null, [shown, selId]);
  const { hilite, themePref, setThemePref, hiliteError } = useDiffHighlight(selected?.file_path);
  const totals = useMemo(
    () => changes.reduce((a, c) => ({ add: a.add + c.additions, del: a.del + c.deletions }), { add: 0, del: 0 }),
    [changes],
  );
  const inc = useIncremental(shown, q);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <style>{SCROLLBAR_CSS}{SPLIT_SEL_CSS}</style>

      <div className="flex items-center gap-3 px-4 shrink-0 border-b" style={{ height: 48, borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
        {onBack && (
          <button onClick={onBack} title={backLabel || "Back"}
            className="shrink-0 px-2.5 py-1 rounded-lg text-[11px] flex items-center gap-1.5"
            style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg3) 45%, transparent)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {backLabel || "Back"}
          </button>
        )}
        <p className="min-w-0 text-[12px] truncate" style={{ color: "var(--text)" }}>{title || "Changes"}</p>
        <span className="shrink-0 text-[11px] tabular-nums" style={{ color: "var(--text3)" }}>
          {changes.length} {changes.length === 1 ? "file" : "files"}
          {" · "}<span style={{ color: "var(--success)" }}>+{totals.add}</span>
          {" "}<span style={{ color: "var(--error)" }}>−{totals.del}</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Toggle on={split} onClick={() => { setSplit(!split); setDiffSplit(!split); }} title="Side by side">split</Toggle>
          <Toggle on={wrap} onClick={() => { setWrap(!wrap); setDiffWrap(!wrap); }} title="Wrap long lines">wrap</Toggle>
          <ThemePicker value={themePref} onChange={setThemePref} error={hiliteError} />
          <CloseButton onClick={onClose} />
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="shrink-0 flex flex-col min-h-0" style={{ width: sidebarW }}>
          {changes.length > 12 && (
            <div className="px-3 py-2 shrink-0">
              <input
                value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Filter by file path…" aria-label="Filter the list" spellCheck={false}
                className="w-full px-3 py-1.5 rounded-lg text-[11.5px] outline-none"
                style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", color: "var(--text)" }}
              />
            </div>
          )}
          <div ref={listRef} onScroll={inc.onScroll} className="agx-scroll flex-1 min-h-0 overflow-y-auto px-2 py-2">
            {!shown.length && (
              <p className="text-center py-10 text-[12px]" style={{ color: "var(--text4)" }}>
                {q ? "Nothing matches that filter" : "This changeset is empty"}
              </p>
            )}
            {inc.rows.map((c) => {
              const name = c.file_path.slice(c.file_path.lastIndexOf("/") + 1);
              const dir = c.file_path.slice(0, c.file_path.length - name.length).replace(/\/$/, "");
              const on = c.id === selected?.id;
              return (
                <div
                  key={c.id} role="button" tabIndex={-1} onClick={() => setSelId(c.id)}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded-md cursor-default"
                  style={{ background: on ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent" }}
                >
                  <span className="min-w-0 flex-1 flex items-baseline gap-1.5">
                    <span className="text-[11.5px] truncate" style={{ color: "var(--text)" }}>{name}</span>
                    {dir && <span className="text-[10px] truncate shrink" style={{ color: "var(--text4)" }}>{dir}</span>}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums">
                    {c.additions > 0 && <span style={{ color: "var(--success)" }}>+{c.additions}</span>}
                    {c.deletions > 0 && <span style={{ color: "var(--error)" }}> −{c.deletions}</span>}
                  </span>
                </div>
              );
            })}
            {inc.more && (
              <button onClick={inc.showAll} className="w-full py-2 text-[11px] rounded-md hover:bg-white/5" style={{ color: "var(--text3)" }}>
                Show the rest
              </button>
            )}
          </div>
        </div>

        <SidebarGrip />

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {selected && (
            <div className="px-4 py-2 shrink-0 border-b" style={{ borderColor: "color-mix(in srgb, var(--border) 35%, transparent)" }}>
              <p className="text-[12px] truncate" style={{ color: "var(--text)" }}>{selected.file_path}</p>
            </div>
          )}
          <div className="agx-scroll flex-1 min-h-0 overflow-auto">
            {!selected && <Empty>Nothing selected</Empty>}
            {/* A file with no hunks is a real thing — a binary, a rename, a mode
                change — and saying so is the whole difference between this and
                the blank pane it replaces. */}
            {selected && !selected.hunks.length && <Empty>No textual change to show — binary, a rename, or a mode change</Empty>}
            {selected && selected.hunks.length > 0 && (
              <HiliteCtx.Provider value={hilite}>
                {split ? <SplitDiff c={selected} wrap={wrap} /> : <UnifiedDiff c={selected} wrap={wrap} />}
              </HiliteCtx.Provider>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center p-8">
      <p className="text-[12px] text-center" style={{ color: "var(--text4)" }}>{children}</p>
    </div>
  );
}
