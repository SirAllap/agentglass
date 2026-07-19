import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { FileChange, DiffHunk, WalkthroughResult, WalkthroughFile } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { CommitModal } from "./CommitModal.tsx";
import { api } from "../lib/api.ts";
import { usePoll } from "../lib/usePoll.ts";
import { fmtTime, agentKey } from "../lib/format.ts";
import { THEMES } from "../lib/highlight.ts";
import { HiliteCtx, useDiffHighlight } from "../lib/diffHighlight.ts";
import type { Hilite } from "../lib/diffHighlight.ts";

const HATCH = "repeating-linear-gradient(45deg, transparent, transparent 5px, color-mix(in srgb, var(--border) 10%, transparent) 5px, color-mix(in srgb, var(--border) 10%, transparent) 6px)";
// Typical diff/coding font stack (honors an app --font-mono override if set).
const DIFF_FONT = 'var(--font-mono, "JetBrainsMono Nerd Font Mono"), "JetBrainsMono Nerd Font", "JetBrains Mono", "SF Mono", ui-monospace, "Cascadia Code", "Fira Code", "Menlo", "Monaco", "Roboto Mono", "Consolas", "Liberation Mono", monospace';
// Diff font + programming ligatures (== -> => etc.) — JetBrains Mono & friends.
export const CODE_FONT_STYLE = { fontFamily: DIFF_FONT, fontFeatureSettings: '"calt" 1, "liga" 1' } as const;
// Confine text selection to the side the drag started on (split view) so
// selecting the left column doesn't also grab the right. `data-sel` is set
// imperatively on mousedown, before the browser extends the selection.
export const SPLIT_SEL_CSS = '.agx-split[data-sel="l"] [data-side="r"]{user-select:none;-webkit-user-select:none}.agx-split[data-sel="r"] [data-side="l"]{user-select:none;-webkit-user-select:none}';
// Themed, slim scrollbars for the modal's scrollers (primary-tinted thumb).
export const SCROLLBAR_CSS = '.agx-scroll{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--primary) 45%,transparent) transparent}.agx-scroll::-webkit-scrollbar{width:11px;height:11px}.agx-scroll::-webkit-scrollbar-track{background:transparent}.agx-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--primary) 38%,transparent);border-radius:999px;border:3px solid transparent;background-clip:padding-box}.agx-scroll::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--primary) 62%,transparent);background-clip:padding-box}.agx-scroll::-webkit-scrollbar-corner{background:transparent}';
const cellBg = (k?: string) => (k === "del" ? "color-mix(in srgb, var(--error) 13%, transparent)" : k === "add" ? "color-mix(in srgb, var(--success) 13%, transparent)" : "transparent");
const cellFg = (k?: string) => (k === "del" ? "var(--error)" : k === "add" ? "var(--success)" : "var(--text3)");
// Opaque variant of the row tint — for the sticky line-number gutter, so
// scrolling code passes behind it instead of showing through.
const numBg = (k?: string) => (k === "del" ? "color-mix(in srgb, var(--error) 13%, var(--bg))" : k === "add" ? "color-mix(in srgb, var(--success) 13%, var(--bg))" : "var(--bg)");
const kindOf = (tag: string): "ctx" | "del" | "add" => (tag === "+" ? "add" : tag === "-" ? "del" : "ctx");

// --- word-level (intra-line) diff --------------------------------------------
type Seg = { text: string; hi: boolean };
const WORD_RE = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;
const tokenize = (s: string): string[] => s.match(WORD_RE) ?? [];

/** Token LCS between two lines → highlighted segments per side, or null when the
 *  lines are too dissimilar to be "the same line modified" (keeps the naive
 *  del/add pairing from painting noisy word highlights on unrelated lines). */
function wordDiff(a: string, b: string): { left: Seg[]; right: Seg[] } | null {
  if (!a || !b || a === b || a.length + b.length > 4000) return null;
  const ta = tokenize(a), tb = tokenize(b);
  const n = ta.length, m = tb.length;
  if (n + m > 600) return null;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const left: Seg[] = [], right: Seg[] = [];
  const push = (arr: Seg[], text: string, hi: boolean) => {
    const last = arr[arr.length - 1];
    if (last && last.hi === hi) last.text += text; else arr.push({ text, hi });
  };
  let i = 0, j = 0, eq = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { push(left, ta[i], false); push(right, tb[j], false); eq += ta[i].length; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push(left, ta[i++], true);
    else push(right, tb[j++], true);
  }
  while (i < n) push(left, ta[i++], true);
  while (j < m) push(right, tb[j++], true);
  if ((2 * eq) / (a.length + b.length) < 0.4) return null; // too different → render plain
  return { left, right };
}

/** In a unified row list, pair each del with the following add at the same
 *  offset and attach word-diff segments to those modified pairs. */
function attachWordDiff(rows: URow[]): void {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "del") { i++; continue; }
    let d = i; while (d < rows.length && rows[d].kind === "del") d++;
    let a = d; while (a < rows.length && rows[a].kind === "add") a++;
    for (let k = 0; k < Math.min(d - i, a - d); k++) {
      const wd = wordDiff(rows[i + k].text, rows[d + k].text);
      if (wd) { rows[i + k].segs = wd.left; rows[d + k].segs = wd.right; }
    }
    i = a;
  }
}

function Marked({ segs, kind }: { segs: Seg[]; kind: "del" | "add" }) {
  const bg = kind === "del" ? "color-mix(in srgb, var(--error) 30%, transparent)" : "color-mix(in srgb, var(--success) 30%, transparent)";
  return <>{segs.map((s, i) => (s.hi ? <span key={i} style={{ background: bg, borderRadius: "2px" }}>{s.text}</span> : <span key={i}>{s.text}</span>))}</>;
}

// --- syntax highlighting (Shiki) composed with the word-level diff ------------
function changedRanges(segs?: Seg[] | null): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!segs) return out;
  let off = 0;
  for (const s of segs) { if (s.hi) out.push([off, off + s.text.length]); off += s.text.length; }
  return out;
}

/** A diff line's text with Shiki token colors (foreground) and the word-level
 *  diff painted as a stronger background over the changed spans. Falls back to
 *  plain text / <Marked> until the highlighter + language load (or unknown lang). */
const Code = memo(function Code({ text, segs, kind }: { text: string; segs?: Seg[] | null; kind: "ctx" | "del" | "add" }) {
  const { hl, lang, theme } = useContext(HiliteCtx);
  const tokens = useMemo(() => {
    if (!hl || !lang || !theme || !text) return null;
    try { return hl.codeToTokens(text, { lang: lang as never, theme }).tokens[0] ?? []; } catch { return null; }
  }, [hl, lang, theme, text]);
  if (!tokens) return segs ? <Marked segs={segs} kind={kind === "del" ? "del" : "add"} /> : <>{text || " "}</>;
  const ranges = changedRanges(segs);
  const hiBg = kind === "del" ? "color-mix(in srgb, var(--error) 32%, transparent)" : "color-mix(in srgb, var(--success) 32%, transparent)";
  const out: React.ReactNode[] = [];
  let off = 0, key = 0;
  for (const tok of tokens) {
    const start = off, end = off + tok.content.length;
    // Shiki's fontStyle bitmask: 1=italic, 2=bold, 4=underline.
    const fs = tok.fontStyle ?? 0;
    const face: React.CSSProperties = { color: tok.color };
    if (fs & 2) face.fontWeight = 700;
    if (fs & 1) face.fontStyle = "italic";
    if (fs & 4) face.textDecoration = "underline";
    const cuts = [start, end];
    for (const [a, b] of ranges) if (b > start && a < end) cuts.push(Math.max(a, start), Math.min(b, end));
    const pts = [...new Set(cuts)].sort((x, y) => x - y);
    for (let i = 0; i < pts.length - 1; i++) {
      const s = pts[i], e = pts[i + 1];
      const piece = tok.content.slice(s - start, e - start);
      if (!piece) continue;
      const hi = ranges.some(([a, b]) => s >= a && e <= b && b > a);
      out.push(<span key={key++} style={hi ? { ...face, background: hiBg, borderRadius: "2px" } : face}>{piece}</span>);
    }
    off = end;
  }
  return <>{out}</>;
});

// --- unified diff, with old|new gutters, uncapped -----------------------------
type URow = { oldN: number | null; newN: number | null; text: string; kind: "ctx" | "del" | "add"; segs?: Seg[] | null };
function unifiedRows(h: DiffHunk): URow[] {
  const rows: URow[] = [];
  let oldN = h.oldStart, newN = h.newStart;
  for (const line of h.lines) {
    const kind = kindOf(line[0]);
    const text = line.slice(1);
    if (kind === "add") rows.push({ oldN: null, newN: newN++, text, kind });
    else if (kind === "del") rows.push({ oldN: oldN++, newN: null, text, kind });
    else rows.push({ oldN: oldN++, newN: newN++, text, kind });
  }
  attachWordDiff(rows);
  return rows;
}

export function UnifiedDiff({ c, wrap, hunkAction }: { c: FileChange; wrap: boolean; hunkAction?: (hunkIndex: number) => React.ReactNode }) {
  const wrapCls = wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre";
  const hunks = useMemo(() => c.hunks.map((h) => ({ h, rows: unifiedRows(h) })), [c]);
  return (
    <div className="agx-scroll flex-1 min-w-0 overflow-auto text-[12px] leading-[1.6]" data-vscroll style={CODE_FONT_STYLE}>
      {hunks.map(({ h, rows }, hi) => (
        <div key={hi}>
          <div data-hunk className="sticky top-0 z-20 py-0.5 t-dim2" style={{ background: "color-mix(in srgb, var(--info) 12%, var(--bg))" }}>
            <span className="sticky left-0 inline-flex items-center gap-3 px-3">
              <span className="whitespace-pre">@@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</span>
              {hunkAction && hunkAction(hi)}
            </span>
          </div>
          <div className="grid" style={{ gridTemplateColumns: wrap ? "4ch 4ch minmax(0,1fr)" : "4ch 4ch max-content" }}>
            {rows.map((r, ri) => (
              <div key={ri} className="contents">
                <div className="text-right pr-1.5 tabular-nums select-none sticky z-[1]" style={{ left: 0, background: numBg(r.kind) }}><span className="opacity-40">{r.oldN ?? ""}</span></div>
                <div className="text-right pr-1.5 tabular-nums select-none sticky z-[1]" style={{ left: "4ch", background: numBg(r.kind), boxShadow: "1px 0 0 0 color-mix(in srgb, var(--border) 22%, transparent)" }}><span className="opacity-40">{r.newN ?? ""}</span></div>
                <div className={`${wrapCls} px-1.5`} style={{ background: cellBg(r.kind), color: cellFg(r.kind) }}>
                  <span className="select-none opacity-60">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "} </span><Code text={r.text} segs={r.segs} kind={r.kind} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- side-by-side (split) diff, codiff-style, uncapped -----------------------
type Cell = { num: number; text: string; kind: "ctx" | "del" | "add"; segs?: Seg[] | null };

/** Turn a unified hunk into paired old|new rows: removals sit left, additions
 *  right, and a change block zips its −/+ lines together row by row. */
function splitRows(h: DiffHunk): { l: Cell | null; r: Cell | null }[] {
  const rows: { l: Cell | null; r: Cell | null }[] = [];
  let oldN = h.oldStart, newN = h.newStart;
  let dels: Cell[] = [], adds: Cell[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const l = dels[i] ?? null, r = adds[i] ?? null;
      if (l && r) { const wd = wordDiff(l.text, r.text); if (wd) { l.segs = wd.left; r.segs = wd.right; } }
      rows.push({ l, r });
    }
    dels = []; adds = [];
  };
  for (const line of h.lines) {
    const tag = line[0], text = line.slice(1);
    if (tag === "-") dels.push({ num: oldN++, text, kind: "del" });
    else if (tag === "+") adds.push({ num: newN++, text, kind: "add" });
    else { flush(); rows.push({ l: { num: oldN++, text, kind: "ctx" }, r: { num: newN++, text, kind: "ctx" } }); }
  }
  flush();
  return rows;
}

// Split view: two side-by-side columns, each its OWN horizontal scroller (so a
// long line on one side scrolls independently, with its scrollbar pinned to the
// bottom of the pane). Vertical scroll is kept in sync between the two so rows
// stay aligned; only the right side shows the vertical scrollbar.
export function SplitDiff({ c, wrap }: { c: FileChange; wrap: boolean }) {
  const hunks = useMemo(() => c.hunks.map((h) => ({ h, rows: splitRows(h) })), [c]);
  const wrapCls = wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre";
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const onDown = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest("[data-side]") as HTMLElement | null;
    if (el?.dataset.side) (e.currentTarget as HTMLElement).setAttribute("data-sel", el.dataset.side);
  };
  const syncTop = () => {
    const src = rightRef.current, dst = leftRef.current;
    if (!src || !dst || syncing.current) return;
    syncing.current = true;
    dst.scrollTop = src.scrollTop;
    requestAnimationFrame(() => { syncing.current = false; });
  };
  const onLeftWheel = (e: React.WheelEvent) => {
    // left has no vertical scrollbar — forward vertical wheel to the right side
    if (rightRef.current && e.deltaY) { rightRef.current.scrollTop += e.deltaY; e.preventDefault(); }
  };
  const side = (which: "l" | "r") =>
    hunks.map(({ h, rows }, hi) => (
      <div key={hi} style={{ minWidth: "max-content" }}>
        <div data-hunk className="sticky top-0 z-20 py-0.5 t-dim2 whitespace-pre" style={{ background: "color-mix(in srgb, var(--info) 12%, var(--bg))" }}>
          <span className="sticky left-0 inline-block px-3">@@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</span>
        </div>
        {rows.map((row, ri) => {
          const cell = which === "l" ? row.l : row.r;
          return (
            <div key={ri} className="flex" style={{ minWidth: "100%", background: cell ? cellBg(cell.kind) : HATCH }}>
              <div data-side={which} className="text-right pr-1.5 tabular-nums select-none shrink-0 sticky left-0 z-[1]" style={{ width: "3.6ch", background: numBg(cell?.kind), boxShadow: "1px 0 0 0 color-mix(in srgb, var(--border) 22%, transparent)" }}><span className="opacity-40">{cell?.num ?? ""}</span></div>
              <div className={`${wrapCls} px-1.5`} style={{ color: cellFg(cell?.kind) }}>{cell ? <Code text={cell.text} segs={cell.segs} kind={cell.kind} /> : ""}</div>
            </div>
          );
        })}
      </div>
    ));

  // WRAP: one aligned grid, no horizontal scroll — lines wrap in place and both
  // sides keep matching row heights (grid rows take the taller of the two).
  if (wrap) {
    return (
      <div className="agx-split agx-scroll flex-1 min-w-0 overflow-auto text-[12px] leading-[1.6]" data-vscroll style={CODE_FONT_STYLE} onMouseDown={onDown}>
        <style>{SPLIT_SEL_CSS}</style>
        {hunks.map(({ h, rows }, hi) => (
          <div key={hi}>
            <div data-hunk className="sticky top-0 z-20 px-3 py-0.5 t-dim2 whitespace-pre" style={{ background: "color-mix(in srgb, var(--info) 12%, var(--bg))" }}>
              @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
            </div>
            <div className="grid" style={{ gridTemplateColumns: "3.6ch minmax(0,1fr) 3.6ch minmax(0,1fr)" }}>
              {rows.map((row, ri) => (
                <div key={ri} className="contents">
                  <div data-side="l" className="text-right pr-1.5 tabular-nums select-none" style={{ background: row.l ? cellBg(row.l.kind) : HATCH }}><span className="opacity-40">{row.l?.num ?? ""}</span></div>
                  <div data-side="l" className="whitespace-pre-wrap break-all px-1.5" style={{ background: row.l ? cellBg(row.l.kind) : HATCH, color: cellFg(row.l?.kind) }}>{row.l ? <Code text={row.l.text} segs={row.l.segs} kind={row.l.kind} /> : ""}</div>
                  <div data-side="r" className="text-right pr-1.5 tabular-nums select-none border-l" style={{ background: row.r ? cellBg(row.r.kind) : HATCH, borderColor: "color-mix(in srgb, var(--border) 35%, transparent)" }}><span className="opacity-40">{row.r?.num ?? ""}</span></div>
                  <div data-side="r" className="whitespace-pre-wrap break-all px-1.5" style={{ background: row.r ? cellBg(row.r.kind) : HATCH, color: cellFg(row.r?.kind) }}>{row.r ? <Code text={row.r.text} segs={row.r.segs} kind={row.r.kind} /> : ""}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="agx-split flex flex-1 min-w-0 text-[12px] leading-[1.6]" style={CODE_FONT_STYLE} onMouseDown={onDown}>
      <style>{SPLIT_SEL_CSS}</style>
      <div ref={leftRef} data-side="l" className="agx-scroll flex-1 min-w-0" style={{ overflowX: "auto", overflowY: "hidden" }} onWheel={onLeftWheel}>
        {side("l")}
      </div>
      <div ref={rightRef} data-side="r" data-vscroll className="agx-scroll flex-1 min-w-0 border-l" style={{ overflow: "auto", borderColor: "color-mix(in srgb, var(--border) 35%, transparent)" }} onScroll={syncTop}>
        {side("r")}
      </div>
    </div>
  );
}

// --- file classification + grouping (master) ---------------------------------
const TYPE_STYLE: Record<string, string> = {
  FEATURE: "var(--success)",
  EDIT: "var(--info)",
  FIX: "var(--error)",
  REFACTOR: "var(--info)",
  TEST: "var(--warning)",
  CONFIG: "var(--text3)",
  DOCS: "var(--primary)",
  STYLE: "var(--info)",
  CHORE: "var(--text3)",
};

/** Heuristic change type for the file tag — no LLM. Honest labels: FEATURE = new
 *  / purely additive, EDIT = modification; TEST/CONFIG/DOCS/STYLE keyed off path. */
function fileType(c: FileChange): { label: string; color: string } {
  const p = c.file_path.toLowerCase();
  let label: string;
  if (/(^|\/)__tests__\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /\.(test|spec)\./.test(p)) label = "TEST";
  else if (/package\.json|package-lock|bun\.lock|yarn\.lock|pnpm-lock|tsconfig|\.ya?ml$|\.toml$|\.ini$|(^|\/)\.env|dockerfile|vite\.config|tailwind\.config|postcss\.config|eslint|prettier|\.config\.[cm]?[jt]s$/.test(p)) label = "CONFIG";
  else if (/\.mdx?$|(^|\/)readme|(^|\/)license|(^|\/)changelog|\.txt$/.test(p)) label = "DOCS";
  else if (/\.(css|scss|sass|less)$/.test(p)) label = "STYLE";
  else if (c.tool === "Write" || c.deletions === 0) label = "FEATURE";
  else label = "EDIT";
  return { label, color: TYPE_STYLE[label] ?? "var(--info)" };
}

type GroupBy = "session" | "agent" | "folder" | "tool";
const GROUP_DIMS: { id: GroupBy; label: string }[] = [
  { id: "session", label: "Session" },
  { id: "agent", label: "Agent" },
  { id: "folder", label: "Folder" },
  { id: "tool", label: "Tool" },
];
type FileGroup = { key: string; label: string; sub?: string; items: FileChange[]; add: number; del: number };

const dirOf = (path: string) => {
  const base = path.split("/").pop() ?? "";
  return path.slice(0, path.length - base.length).replace(/\/+$/, "") || "./";
};
const shortDir = (dir: string) => {
  if (dir === "./") return "./";
  const segs = dir.split("/").filter(Boolean);
  return segs.length <= 2 ? dir.replace(/^\//, "") : "…/" + segs.slice(-2).join("/");
};

/** Bucket the (already path-filtered) changes into groups, preserving first-seen
 *  order — the API returns newest-first, so recent activity floats to the top. */
function groupChanges(list: FileChange[], by: GroupBy): FileGroup[] {
  const map = new Map<string, FileGroup>();
  const order: string[] = [];
  for (const c of list) {
    let key: string, label: string, sub: string | undefined;
    if (by === "session") { key = `${c.source_app}:${c.session_id}`; label = agentKey({ source_app: c.source_app, session_id: c.session_id }); sub = c.source_app; }
    else if (by === "agent") { key = c.source_app || "—"; label = c.source_app || "unknown"; }
    else if (by === "tool") { key = c.tool || "—"; label = c.tool || "unknown"; }
    else { const d = dirOf(c.file_path); key = d; label = shortDir(d); }
    let g = map.get(key);
    if (!g) { g = { key, label, sub, items: [], add: 0, del: 0 }; map.set(key, g); order.push(key); }
    g.items.push(c); g.add += c.additions; g.del += c.deletions;
  }
  return order.map((k) => map.get(k)!);
}

function TypeTag({ c, override }: { c: FileChange; override?: string }) {
  const label = override ? override.toUpperCase() : fileType(c).label;
  const color = TYPE_STYLE[label] ?? fileType(c).color;
  return <span className="chip shrink-0 text-[9px] tracking-wide" style={{ color, background: `color-mix(in srgb, ${color} 15%, transparent)` }}>{label}</span>;
}

function ReviewDot({ on, onClick, title }: { on: boolean; onClick?: (e: React.MouseEvent) => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] leading-none transition-colors"
      style={{
        color: on ? "var(--success)" : "var(--text3)",
        border: `1px solid ${on ? "color-mix(in srgb, var(--success) 70%, transparent)" : "color-mix(in srgb, var(--border) 55%, transparent)"}`,
        background: on ? "color-mix(in srgb, var(--success) 18%, transparent)" : "transparent",
      }}
    >{on ? "✓" : ""}</button>
  );
}

function FileItem({ c, active, reviewed, info, onSelect, onToggleReviewed }: { c: FileChange; active: boolean; reviewed: boolean; info?: WalkthroughFile; onSelect: () => void; onToggleReviewed: () => void }) {
  const base = c.file_path.split("/").pop();
  return (
    <div
      data-file={active ? "active" : undefined}
      role="button"
      tabIndex={-1}
      onClick={onSelect}
      className="w-full text-left rounded-lg px-2 py-1.5 transition-colors cursor-pointer"
      style={{
        background: active ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
        border: `1px solid ${active ? "color-mix(in srgb, var(--primary) 32%, transparent)" : "transparent"}`,
      }}
    >
      <div className="flex items-center gap-1.5">
        <ReviewDot on={reviewed} onClick={(e) => { e.stopPropagation(); onToggleReviewed(); }} title={reviewed ? "Mark unreviewed (x)" : "Mark reviewed (x)"} />
        <TypeTag c={c} override={info?.tag} />
        <span className="text-[11.5px] font-medium truncate" style={{ color: reviewed ? "var(--text3)" : "var(--text)" }}>{base}</span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0 text-[10px] tabular-nums">
          {c.additions > 0 && <span style={{ color: "var(--success)" }}>+{c.additions}</span>}
          {c.deletions > 0 && <span style={{ color: "var(--error)" }}>−{c.deletions}</span>}
        </span>
      </div>
      {info?.description ? (
        <div className="mt-0.5 text-[10px] pl-[22px] truncate" style={{ color: "var(--text3)" }} title={info.description}>{info.description}</div>
      ) : (
        <div className="flex items-center gap-1.5 mt-0.5 text-[9.5px] t-dim2 pl-[22px]">
          <span className="truncate min-w-0" title={c.file_path}>{dirOf(c.file_path)}</span>
          <span className="ml-auto shrink-0 opacity-80">{c.tool}</span>
          <span className="shrink-0">{fmtTime(c.timestamp)}</span>
        </div>
      )}
    </div>
  );
}

function GroupBlock({ g, collapsed, selId, reviewed, descMap, onToggleCollapse, onSelect, onToggleReviewed, onToggleGroup }: {
  g: FileGroup; collapsed: boolean; selId: number | null; reviewed: Set<number>; descMap: Map<string, WalkthroughFile>;
  onToggleCollapse: () => void; onSelect: (id: number) => void; onToggleReviewed: (id: number) => void; onToggleGroup: (g: FileGroup, next: boolean) => void;
}) {
  const revCount = g.items.reduce((n, c) => n + (reviewed.has(c.id) ? 1 : 0), 0);
  const allRev = revCount === g.items.length;
  return (
    <div className="mb-1">
      <div className="flex items-center gap-1.5 px-1.5 py-1 rounded-md" style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)" }}>
        <button onClick={onToggleCollapse} className="flex items-center gap-1.5 min-w-0 flex-1 text-left">
          <span className="text-[9px] t-dim2 transition-transform shrink-0" style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}>▾</span>
          <span className="text-[11px] font-semibold truncate" style={{ color: "var(--text2, var(--text))" }}>{g.label}</span>
          {g.sub && <span className="text-[9px] t-dim2 shrink-0 truncate">{g.sub}</span>}
        </button>
        <span className="shrink-0 text-[9.5px] tabular-nums flex items-center gap-1.5">
          <span className="t-dim2">{g.items.length}</span>
          {g.add > 0 && <span style={{ color: "var(--success)" }}>+{g.add}</span>}
          {g.del > 0 && <span style={{ color: "var(--error)" }}>−{g.del}</span>}
        </span>
        <button
          onClick={() => onToggleGroup(g, !allRev)}
          title={allRev ? "Mark group unreviewed" : "Mark whole group reviewed"}
          className="shrink-0 text-[9px] tabular-nums px-1 rounded hover:opacity-80"
          style={{ color: allRev ? "var(--success)" : "var(--text3)" }}
        >{revCount}/{g.items.length}</button>
      </div>
      {!collapsed && (
        <div className="mt-0.5 space-y-0.5">
          {g.items.map((c) => (
            <FileItem key={c.id} c={c} active={c.id === selId} reviewed={reviewed.has(c.id)} info={descMap.get(c.file_path)} onSelect={() => onSelect(c.id)} onToggleReviewed={() => onToggleReviewed(c.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- controls ----------------------------------------------------------------
// Syntax-theme dropdown (Shiki). "auto" follows the app's light/dark; the rest
// mirror the user's Neovim themes. Grouped dark/light, closes on outside click.
export function ThemePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey, true); };
  }, [open]);
  const label = value === "auto" ? "Auto" : (THEMES.find((t) => t.id === value)?.label ?? value);
  const pick = (v: string) => { onChange(v); setOpen(false); };
  const Row = ({ id, name }: { id: string; name: string }) => (
    <button
      onClick={() => pick(id)}
      className="w-full text-left px-2.5 py-1 flex items-center gap-2 transition-colors"
      style={{ background: value === id ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent", color: value === id ? "var(--text)" : "var(--text2)" }}
    >
      <span className="w-2.5 shrink-0" style={{ color: "var(--primary)" }}>{value === id ? "✓" : ""}</span>
      <span className="truncate">{name}</span>
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Syntax theme"
        className="px-2 py-0.5 rounded-md text-[10px] transition-colors flex items-center gap-1"
        style={{ background: "color-mix(in srgb, var(--bg3) 45%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", color: "var(--text3)" }}
      >
        <span className="truncate" style={{ maxWidth: 92 }}>{label}</span>
        <span style={{ opacity: 0.6, fontSize: 8 }}>▼</span>
      </button>
      {open && (
        <div
          className="agx-scroll absolute right-0 mt-1 rounded-lg py-1 text-[10.5px] shadow-2xl"
          style={{ zIndex: 20, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", minWidth: 178, maxHeight: 340, overflowY: "auto" }}
        >
          <Row id="auto" name="Auto (app theme)" />
          <div className="px-2.5 pt-1.5 pb-0.5 text-[8.5px] uppercase tracking-wider t-dim2">Dark</div>
          {THEMES.filter((t) => t.dark).map((t) => <Row key={t.id} id={t.id} name={t.label} />)}
          <div className="px-2.5 pt-1.5 pb-0.5 text-[8.5px] uppercase tracking-wider t-dim2">Light</div>
          {THEMES.filter((t) => !t.dark).map((t) => <Row key={t.id} id={t.id} name={t.label} />)}
        </div>
      )}
    </div>
  );
}

export function Toggle({ on, onClick, children, title }: { on?: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="px-2 py-0.5 rounded-md text-[10px] transition-colors"
      style={{
        background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "color-mix(in srgb, var(--bg3) 45%, transparent)",
        border: `1px solid color-mix(in srgb, var(--border) ${on ? 50 : 30}%, transparent)`,
        color: on ? "var(--text)" : "var(--text3)",
      }}
    >
      {children}
    </button>
  );
}

const REVIEW_KEY = "agentglass.reviewedChanges";
const GROUPBY_KEY = "agentglass.diffGroupBy";
const WALK_KEY = "agentglass.walkCache";

// The AI walkthrough is cached per *changeset* (persisted), so it survives
// closing/reopening the modal and never re-hits the LLM for the same diffs.
// The signature is order-independent and changes when any file's size changes.
type WalkCache = Record<string, WalkthroughResult>;
export function changesetSig(list: FileChange[]): string {
  const s = list.map((c) => `${c.file_path}:${c.additions}:${c.deletions}`).sort().join("|");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `${list.length}.${(h >>> 0).toString(36)}`;
}
export function readWalkCache(): WalkCache {
  try { return JSON.parse(localStorage.getItem(WALK_KEY) || "{}") as WalkCache; } catch { return {}; }
}
export function writeWalkCache(sig: string, r: WalkthroughResult) {
  try {
    const c = readWalkCache();
    c[sig] = r;
    const keys = Object.keys(c);
    if (keys.length > 24) delete c[keys[0]]; // keep the cache bounded
    localStorage.setItem(WALK_KEY, JSON.stringify(c));
  } catch { /* ignore */ }
}

export function ChangesModal({ open, onClose, onBack, backLabel, presetChanges, presetTitle, presetPath }: { open: boolean; onClose: () => void; onBack?: () => void; backLabel?: string; presetChanges?: FileChange[]; presetTitle?: string; presetPath?: string }) {
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  const [q, setQ] = useState("");
  const [selId, setSelId] = useState<number | null>(null);
  const [wrap, setWrap] = useState(false);
  const [split, setSplit] = useState(true);
  const [copied, setCopied] = useState<null | "path" | "diff">(null);
  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    try { const v = localStorage.getItem(GROUPBY_KEY); if (v === "session" || v === "agent" || v === "folder" || v === "tool") return v; } catch { /* ignore */ }
    return "session";
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [reviewed, setReviewed] = useState<Set<number>>(() => new Set());
  const [commitOpen, setCommitOpen] = useState(false);
  const [walk, setWalk] = useState<WalkthroughResult | null>(null);
  const [walkLoading, setWalkLoading] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const walkReqSig = useRef<string | null>(null); // guards stale walkthrough responses

  useEffect(() => {
    if (!open) return;
    setChanges(null);
    setQ("");
    setCollapsed(new Set());
    // walk state is (re)hydrated from the per-changeset cache by its own effect
    try { const raw = localStorage.getItem(REVIEW_KEY); setReviewed(new Set(raw ? JSON.parse(raw) : [])); } catch { setReviewed(new Set()); }
    if (presetChanges) {
      // scoped to a single agent/session's changes (opened from SessionModal)
      setChanges(presetChanges);
      const sel = presetPath ? presetChanges.find((c) => c.file_path === presetPath) : null;
      setSelId((sel ?? presetChanges[0])?.id ?? null);
    } else {
      api.changes(200).then((r) => {
        setChanges(r.changes);
        setSelId(r.changes[0]?.id ?? null);
      }).catch(() => setChanges([]));
    }
    // focus the frame so j/k nav works immediately (filter is opt-in via click)
    requestAnimationFrame(() => frameRef.current?.focus());
  }, [open]);

  // The fleet keeps editing while this is open, so a list loaded once goes
  // stale within a turn. Refreshed in place rather than through the effect
  // above: that one resets the filter, the collapsed groups and the selection,
  // which would yank the file out from under you mid-read every few seconds.
  //
  // Not polled for a preset changeset — those are one session's changes, handed
  // in already resolved, and re-fetching would replace them with the fleet's.
  usePoll(open && !presetChanges, () => {
    api.changes(200).then((r) => {
      setChanges((prev) => {
        // Same ids in the same order → keep the old array so nothing downstream
        // re-renders or re-highlights on an unchanged poll.
        if (prev && prev.length === r.changes.length && prev.every((c, i) => c.id === r.changes[i].id)) return prev;
        return r.changes;
      });
      setSelId((cur) => (cur && r.changes.some((c) => c.id === cur) ? cur : r.changes[0]?.id ?? null));
    }).catch(() => { /* keep showing what we have */ });
  }, 4000);

  // prune stored "reviewed" ids to those still present; persist the group-by pref
  useEffect(() => {
    if (!changes) return;
    const present = new Set(changes.map((c) => c.id));
    setReviewed((s) => {
      const n = new Set([...s].filter((id) => present.has(id)));
      if (n.size === s.size) return s;
      try { localStorage.setItem(REVIEW_KEY, JSON.stringify([...n])); } catch { /* ignore */ }
      return n;
    });
  }, [changes]);
  useEffect(() => { try { localStorage.setItem(GROUPBY_KEY, groupBy); } catch { /* ignore */ } }, [groupBy]);

  const all = changes ?? [];
  const filtered = useMemo(() => (q ? all.filter((c) => c.file_path.toLowerCase().includes(q.toLowerCase())) : all), [all, q]);
  const groups = useMemo(() => groupChanges(filtered, groupBy), [filtered, groupBy]);
  const shown = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const totals = useMemo(() => all.reduce((a, c) => ({ add: a.add + c.additions, del: a.del + c.deletions }), { add: 0, del: 0 }), [all]);
  const revCount = useMemo(() => all.reduce((n, c) => n + (reviewed.has(c.id) ? 1 : 0), 0), [all, reviewed]);
  const selected = useMemo(() => shown.find((c) => c.id === selId) ?? shown[0] ?? null, [shown, selId]);
  const commitPaths = useMemo(() => [...new Set(all.map((c) => c.file_path))], [all]);
  const walkSig = useMemo(() => changesetSig(all), [all]);
  // Shiki highlighter + theme/bold controls (shared with the git panel).
  const { hilite, themePref, setThemePref, bold, setBold } = useDiffHighlight(selected?.file_path);
  // Restore a cached walkthrough for the current changeset (on open / when the
  // changeset changes) so it persists across close/reopen and never re-runs.
  useEffect(() => {
    if (!open) return;
    walkReqSig.current = null;
    setWalkLoading(false);
    setWalk(all.length ? (readWalkCache()[walkSig] ?? null) : null);
  }, [open, walkSig]);
  const descMap = useMemo(() => {
    const m = new Map<string, WalkthroughFile>();
    for (const f of walk?.files ?? []) m.set(f.path, f);
    return m;
  }, [walk]);
  const groupKeyOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const g of groups) for (const it of g.items) m.set(it.id, g.key);
    return m;
  }, [groups]);

  // keep the selected file valid as the filter narrows the list
  useEffect(() => {
    if (selected && selected.id !== selId) setSelId(selected.id);
  }, [selected, selId]);

  // reset scroll + copy state when the open file changes
  useEffect(() => {
    paneRef.current?.querySelectorAll<HTMLElement>(".agx-scroll").forEach((el) => { el.scrollTop = 0; el.scrollLeft = 0; });
    setCopied(null);
  }, [selected?.id, split, wrap]);

  const persist = (n: Set<number>) => { try { localStorage.setItem(REVIEW_KEY, JSON.stringify([...n])); } catch { /* ignore */ } };
  const toggleReviewed = (id: number) => setReviewed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); persist(n); return n; });
  const toggleGroup = (g: FileGroup, next: boolean) => setReviewed((s) => { const n = new Set(s); for (const c of g.items) { if (next) n.add(c.id); else n.delete(c.id); } persist(n); return n; });
  const toggleCollapse = (key: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const expandGroupOf = (id: number) => { const gk = groupKeyOf.get(id); if (!gk) return; setCollapsed((s) => { if (!s.has(gk)) return s; const n = new Set(s); n.delete(gk); return n; }); };
  const select = (id: number) => { setSelId(id); expandGroupOf(id); };

  const step = (dir: 1 | -1) => {
    if (!shown.length) return;
    const i = Math.max(0, shown.findIndex((c) => c.id === selected?.id));
    const next = shown[(i + dir + shown.length) % shown.length];
    setSelId(next.id);
    expandGroupOf(next.id);
    requestAnimationFrame(() => frameRef.current?.querySelector('[data-file="active"]')?.scrollIntoView({ block: "nearest" }));
  };

  const jumpHunk = (dir: 1 | -1) => {
    const pane = paneRef.current;
    if (!pane) return;
    const sc = (pane.querySelector("[data-vscroll]") as HTMLElement | null) ?? pane;
    const heads = Array.from(sc.querySelectorAll<HTMLElement>("[data-hunk]"));
    if (!heads.length) return;
    const scTop = sc.getBoundingClientRect().top;
    const cur = sc.scrollTop;
    const tops = heads.map((h) => h.getBoundingClientRect().top - scTop + cur);
    const target = dir === 1 ? tops.find((t) => t > cur + 4) : [...tops].reverse().find((t) => t < cur - 4);
    sc.scrollTo({ top: (target ?? (dir === 1 ? tops[tops.length - 1] : tops[0])) - 2, behavior: "smooth" });
  };

  const unifiedText = (c: FileChange) =>
    `--- a/${c.file_path}\n+++ b/${c.file_path}\n` +
    c.hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`).join("\n");

  const copy = (what: "path" | "diff") => {
    if (!selected) return;
    const text = what === "path" ? selected.file_path : unifiedText(selected);
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 1300);
    }).catch(() => {});
  };

  const explain = (force = false) => {
    if (walkLoading || !all.length) return;
    if (!force) {
      const cached = readWalkCache()[walkSig];
      if (cached) { setWalk(cached); return; } // instant — no LLM call
    }
    const reqSig = walkSig;
    walkReqSig.current = reqSig;
    setWalkLoading(true);
    const files = commitPaths.map((p) => {
      const c = all.find((x) => x.file_path === p);
      return { path: p, tool: c?.tool, additions: c?.additions, deletions: c?.deletions, patch: c ? unifiedText(c) : "" };
    });
    api.walkthrough(files)
      .then((r) => {
        if (walkReqSig.current !== reqSig) return; // changeset moved on — drop stale result
        setWalk(r);
        if (r.available && !r.error) writeWalkCache(reqSig, r); // cache only good results
      })
      .catch((e) => { if (walkReqSig.current === reqSig) setWalk({ available: true, reviewFocus: "", files: [], error: String(e) }); })
      .finally(() => { if (walkReqSig.current === reqSig) setWalkLoading(false); });
  };

  const onKey = (e: React.KeyboardEvent) => {
    const inInput = /input|textarea/i.test((e.target as HTMLElement)?.tagName ?? "");
    if (inInput && e.key !== "Escape") return; // let the filter own its keys
    const k = e.key.toLowerCase();
    if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); step(1); }
    else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); step(-1); }
    else if (k === "n") { e.preventDefault(); e.stopPropagation(); jumpHunk(1); }
    else if (k === "p") { e.preventDefault(); e.stopPropagation(); jumpHunk(-1); }
    else if (k === "w") { e.preventDefault(); e.stopPropagation(); setWrap((w) => !w); }
    else if (k === "c") { e.preventDefault(); e.stopPropagation(); copy("path"); }
    else if (k === "x") { e.preventDefault(); e.stopPropagation(); if (selected) toggleReviewed(selected.id); }
  };

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={onClose} />
            <div className="fixed inset-0 flex items-center justify-center p-3 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div
                ref={frameRef}
                tabIndex={-1}
                onKeyDown={onKey}
                initial={{ opacity: 0, scale: 0.95, y: 14 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ type: "spring", stiffness: 330, damping: 30 }}
                className="w-[95vw] h-[95vh] rounded-2xl flex flex-col pointer-events-auto outline-none overflow-hidden"
                style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}
              >
                <style>{SCROLLBAR_CSS}</style>
                <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <div className="flex items-baseline gap-2.5 flex-wrap">
                    <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>File changes</span>
                    {changes && (
                      <span className="text-[10px] t-dim2 tabular-nums">
                        {all.length} edits · <span style={{ color: "var(--success)" }}>+{totals.add}</span> <span style={{ color: "var(--error)" }}>−{totals.del}</span> · {presetTitle || "what the fleet changed"}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {onBack && (
                      <button
                        onClick={onBack}
                        title={backLabel || "Back"}
                        className="text-[11px] px-2.5 py-1 rounded-lg transition-colors"
                        style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg3) 45%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}
                      >← {backLabel || "Back"}</button>
                    )}
                    {changes && all.length > 0 && (
                      <button
                        onClick={() => explain(!!walk)}
                        disabled={walkLoading}
                        title={walk ? "Re-run the AI walkthrough (overwrites the cached one)" : "AI walkthrough — one line per file + a review focus (cached per changeset)"}
                        className="text-[11px] px-2.5 py-1 rounded-lg transition-colors"
                        style={{ color: "var(--text)", background: "color-mix(in srgb, var(--info) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 28%, transparent)", opacity: walkLoading ? 0.6 : 1 }}
                      >{walkLoading ? "✨ explaining…" : walk ? "✨ re-explain" : "✨ Explain"}</button>
                    )}
                    {changes && all.length > 0 && (
                      <button
                        onClick={() => setCommitOpen(true)}
                        title="Compose a git commit from these changes"
                        className="text-[11px] px-2.5 py-1 rounded-lg transition-colors"
                        style={{ color: "var(--text)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)" }}
                      >⎇ Commit…</button>
                    )}
                    <button onClick={onClose} className="text-[18px] leading-none px-2 t-dim2 hover:opacity-70">✕</button>
                  </div>
                </div>

                {(walk?.reviewFocus || walk?.error) && (
                  <div className="px-5 py-1.5 border-b shrink-0 text-[11px]" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)", background: "color-mix(in srgb, var(--info) 6%, transparent)" }}>
                    {walk?.reviewFocus ? (
                      <><span className="t-dim2 uppercase tracking-wide text-[9px] mr-2">Review focus</span><span style={{ color: "var(--text)" }}>{walk.reviewFocus}</span></>
                    ) : (
                      <span style={{ color: "var(--warning)" }}>{walk?.error}</span>
                    )}
                  </div>
                )}

                <div className="flex-1 min-h-0 flex">
                  {/* master — grouped file list */}
                  <div className="w-[300px] shrink-0 flex flex-col border-r" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                    <div className="p-2.5 pb-1.5 shrink-0 space-y-2">
                      <input
                        value={q} onChange={(e) => setQ(e.target.value)}
                        placeholder="Filter by file path…"
                        className="w-full px-3 py-1.5 rounded-lg text-[11px] outline-none"
                        style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }}
                      />
                      <div className="flex items-center gap-1">
                        {GROUP_DIMS.map((d) => (
                          <button
                            key={d.id}
                            onClick={() => setGroupBy(d.id)}
                            className="px-1.5 py-0.5 rounded text-[9.5px] transition-colors"
                            style={{
                              background: groupBy === d.id ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent",
                              color: groupBy === d.id ? "var(--text)" : "var(--text3)",
                              border: `1px solid color-mix(in srgb, var(--border) ${groupBy === d.id ? 45 : 18}%, transparent)`,
                            }}
                          >{d.label}</button>
                        ))}
                        {changes && all.length > 0 && (
                          <span className="ml-auto text-[9.5px] t-dim2 tabular-nums" title="files reviewed">{revCount}/{all.length}</span>
                        )}
                      </div>
                    </div>
                    <div className="agx-scroll flex-1 min-h-0 overflow-y-auto px-2 pb-2">
                      {!changes && <div className="t-dim2 text-center py-10 text-[12px]">loading changes…</div>}
                      {changes && shown.length === 0 && <div className="t-dim2 text-center py-10 text-[12px]">{q ? "no files match your filter" : "no file changes captured yet"}</div>}
                      {groups.map((g) => (
                        <GroupBlock
                          key={g.key}
                          g={g}
                          collapsed={collapsed.has(g.key) && !q}
                          selId={selected?.id ?? null}
                          reviewed={reviewed}
                          descMap={descMap}
                          onToggleCollapse={() => toggleCollapse(g.key)}
                          onSelect={select}
                          onToggleReviewed={toggleReviewed}
                          onToggleGroup={toggleGroup}
                        />
                      ))}
                    </div>
                  </div>

                  {/* detail — full diff */}
                  <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                    {selected ? (
                      <>
                        <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                          <span className="text-[12px] font-medium truncate" style={{ color: "var(--text)" }} title={selected.file_path}>{selected.file_path}</span>
                          <span className="shrink-0 text-[10.5px] tabular-nums flex items-center gap-1.5">
                            {selected.additions > 0 && <span style={{ color: "var(--success)" }}>+{selected.additions}</span>}
                            {selected.deletions > 0 && <span style={{ color: "var(--error)" }}>−{selected.deletions}</span>}
                          </span>
                          <div className="ml-auto flex items-center gap-1.5 shrink-0">
                            <Toggle on={reviewed.has(selected.id)} onClick={() => toggleReviewed(selected.id)} title="Mark this file reviewed (x)">{reviewed.has(selected.id) ? "reviewed ✓" : "review"}</Toggle>
                            <Toggle on={split} onClick={() => setSplit((s) => !s)} title="Split / unified">{split ? "split" : "unified"}</Toggle>
                            <Toggle on={wrap} onClick={() => setWrap((w) => !w)} title="Toggle line wrap (w)">wrap</Toggle>
                            <ThemePicker value={themePref} onChange={setThemePref} />
                            <Toggle on={bold} onClick={() => setBold((b) => !b)} title="Bold keywords, functions & types (Neovim-style)">bold</Toggle>
                            <Toggle onClick={() => copy("path")} title="Copy file path (c)">{copied === "path" ? "copied ✓" : "path"}</Toggle>
                            <Toggle onClick={() => copy("diff")} title="Copy unified diff">{copied === "diff" ? "copied ✓" : "diff"}</Toggle>
                          </div>
                        </div>
                        <div ref={paneRef} className="flex-1 min-h-0 flex relative" style={{ background: "var(--bg)" }}>
                          <HiliteCtx.Provider value={selected.hunks.reduce((n, h) => n + h.lines.length, 0) > 3000 ? { ...hilite, theme: null } : hilite}>{split ? <SplitDiff c={selected} wrap={wrap} /> : <UnifiedDiff c={selected} wrap={wrap} />}</HiliteCtx.Provider>
                        </div>
                        <div className="shrink-0 px-4 py-1 border-t text-[9.5px] t-dim2 flex items-center gap-3" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                          <span><b className="font-semibold">j/k</b> file</span>
                          <span><b className="font-semibold">n/p</b> hunk</span>
                          <span><b className="font-semibold">x</b> reviewed</span>
                          <span><b className="font-semibold">w</b> wrap</span>
                          <span><b className="font-semibold">c</b> copy path</span>
                          <span className="ml-auto tabular-nums">{selected.hunks.length} hunk{selected.hunks.length === 1 ? "" : "s"}</span>
                        </div>
                      </>
                    ) : (
                      <div className="flex-1 flex items-center justify-center t-dim2 text-[12px]">
                        {changes ? "select a file to view its diff" : "loading changes…"}
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            </div>
            <CommitModal open={commitOpen} onClose={() => setCommitOpen(false)} paths={commitPaths} />
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
