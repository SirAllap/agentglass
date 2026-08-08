import { memo, Fragment, createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { diffSplit, diffWrap } from "../lib/diffPrefs.ts";
import { subscribeWorktreeJump, worktreeJump } from "../lib/worktreeJump.ts";
import { viewHeaderClass, viewHeaderStyle } from "./workspace/ViewHeader.tsx";
import { motion, AnimatePresence } from "motion/react";
import type { FileChange, DiffHunk, WalkthroughResult, GitRepoRef } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { PeekFile, type Peek } from "./PeekFile.tsx";
import { api } from "../lib/api.ts";
import { buildTitles } from "../lib/derive.ts";
import { usePoll } from "../lib/usePoll.ts";
import { fmtTime, agentKey } from "../lib/format.ts";
import { THEMES } from "../lib/highlight.ts";
import { HiliteCtx, useDiffHighlight } from "../lib/diffHighlight.ts";
import type { Hilite } from "../lib/diffHighlight.ts";
import { useSidebarWidth } from "../lib/sidebarWidth.ts";
import { SidebarGrip } from "./SidebarGrip.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { ICON } from "../lib/iconSize.ts";

const HATCH = "repeating-linear-gradient(45deg, transparent, transparent 5px, color-mix(in srgb, var(--border) 10%, transparent) 5px, color-mix(in srgb, var(--border) 10%, transparent) 6px)";
// Typical diff/coding font stack (honors an app --font-mono override if set).
const DIFF_FONT = 'var(--font-mono, "SF Mono"), SFMono-Regular, ui-monospace, "Cascadia Code", "Menlo", "Monaco", "Consolas", "Liberation Mono", "JetBrainsMono Nerd Font Mono", monospace';
// Diff font + programming ligatures (== -> => etc.) — JetBrains Mono & friends.
export const CODE_FONT_STYLE = { fontFamily: DIFF_FONT, fontFeatureSettings: '"calt" 1, "liga" 1' } as const;
// Confine text selection to the side the drag started on (split view) so
// selecting the left column doesn't also grab the right. `data-sel` is set
// imperatively on mousedown, before the browser extends the selection.
export const SPLIT_SEL_CSS = '.agx-split[data-sel="l"] [data-side="r"]{user-select:none;-webkit-user-select:none}.agx-split[data-sel="r"] [data-side="l"]{user-select:none;-webkit-user-select:none}';
// Themed, slim scrollbars for the modal's scrollers (primary-tinted thumb).
/** The gutter "+" only appears on the line you are pointing at, so the diff
 *  reads as a diff until you want to say something about it. */
export const LINEBTN_CSS = '.agx-gutter{position:relative}.agx-linebtn{position:absolute;right:-13px;top:50%;transform:translateY(-50%);width:19px;height:19px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:var(--primary);color:#fff;font-size:15px;font-weight:600;line-height:1;opacity:0;transition:opacity .12s,transform .12s;cursor:pointer;z-index:3;box-shadow:0 1px 3px rgba(0,0,0,.35)}.agx-gutter:hover .agx-linebtn,.agx-linebtn:focus-visible,.agx-linebtn[data-open="1"]{opacity:1}.agx-linebtn:hover{transform:translateY(-50%) scale(1.08)}';

/** Line-level review actions, when the diff is a pull request. Present ⇒ the "+"
 *  gutter button opens a menu (comment / suggest / copy link); absent ⇒ it just
 *  fires onPick, which is all the working-tree changes modal needs. */
export const LineMenuCtx = createContext<{ permalink?: (line: number, side: DiffSide) => string | null } | null>(null);

export const SCROLLBAR_CSS = '.agx-scroll{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--primary) 45%,transparent) transparent}.agx-scroll::-webkit-scrollbar{width:11px;height:11px}.agx-scroll::-webkit-scrollbar-track{background:transparent}.agx-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--primary) 38%,transparent);border-radius:999px;border:3px solid transparent;background-clip:padding-box}.agx-scroll::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--primary) 62%,transparent);background-clip:padding-box}.agx-scroll::-webkit-scrollbar-corner{background:transparent}';
/** The directory an editor should open in. The server checks it is a repo and
 *  in scope before using it, and falls back to the workspace root if not. */
const rootOfPath = (p: string) => p.slice(0, p.lastIndexOf("/")) || p;
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
  const bg = kind === "del" ? "color-mix(in srgb, var(--error) 22%, transparent)" : "color-mix(in srgb, var(--success) 22%, transparent)";
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
  const hiBg = kind === "del" ? "color-mix(in srgb, var(--error) 23%, transparent)" : "color-mix(in srgb, var(--success) 23%, transparent)";
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
export function unifiedRows(h: DiffHunk): URow[] {
  const rows: URow[] = [];
  let oldN = h.oldStart, newN = h.newStart;
  for (const line of h.lines) {
    // "\ No newline at end of file" is metadata about the file, not a line in
    // it. Every other diff parser here drops it (prBody.parseUnifiedDiff,
    // server gitwork.parseDiff); a hunk carrying it — the DiffHunk contract
    // admits `\`, and apply-hunk validates it as a legal line — must not paint
    // it as a phantom context row that also nudges every gutter number below.
    if (line.startsWith("\\")) continue;
    const kind = kindOf(line[0]);
    const text = line.slice(1);
    if (kind === "add") rows.push({ oldN: null, newN: newN++, text, kind });
    else if (kind === "del") rows.push({ oldN: oldN++, newN: null, text, kind });
    else rows.push({ oldN: oldN++, newN: newN++, text, kind });
  }
  attachWordDiff(rows);
  return rows;
}

/** Where a comment lands: a line, on a side of the diff, optionally a range. */
export type DiffSide = "LEFT" | "RIGHT";
export type LinePick = { line: number; side: DiffSide; shift: boolean; mode?: "comment" | "suggest" };
export type LineSel = { start: number; end: number; side: DiffSide } | null;

/** Is this line inside the pending selection? */
function inSel(sel: LineSel, n: number | null | undefined, side: DiffSide): boolean {
  if (!sel || n == null || sel.side !== side) return false;
  return n >= Math.min(sel.start, sel.end) && n <= Math.max(sel.start, sel.end);
}

/**
 * The "+" that starts a comment, in the line-number gutter.
 *
 * Per line, not per hunk: a remark belongs to the line it is about, and
 * anchoring every comment to "the last added line of the hunk" put them
 * somewhere nobody chose. Shift-click extends from the last pick, which is how
 * GitHub does a multi-line comment.
 */
function LineBtn({ n, side, onPick }: { n: number | null | undefined; side: DiffSide; onPick?: (p: LinePick) => void }) {
  if (!onPick || n == null) return null;
  return (
    <button
      onClick={(e) => onPick({ line: n, side, shift: e.shiftKey })}
      title={`Line ${n} — comment; shift-click to cover a range`}
      aria-label={`Comment on line ${n}`}
      className="agx-linebtn">+</button>
  );
}

export function UnifiedDiff({ c, wrap, hunkAction, rowAfter, onPick, sel }: { c: FileChange; wrap: boolean; hunkAction?: (hunkIndex: number) => React.ReactNode; rowAfter?: (newN: number | null | undefined, oldN: number | null | undefined) => React.ReactNode; onPick?: (p: LinePick) => void; sel?: LineSel }) {
  const wrapCls = wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre";
  const hunks = useMemo(() => c.hunks.map((h) => ({ h, rows: unifiedRows(h) })), [c]);
  return (
    <div className="agx-scroll flex-1 min-w-0 overflow-auto text-[12px] leading-[1.6]" data-vscroll style={CODE_FONT_STYLE}>
      {hunks.map(({ h, rows }, hi) => (
        <div key={hi}>
          <div data-hunk className="z-10 py-0.5 t-dim2" style={{ position: "var(--agx-hunk-pos, sticky)" as React.CSSProperties["position"], top: "var(--agx-hunk-top, 0px)", background: "color-mix(in srgb, var(--info) 12%, var(--bg))" }}>
            <span className="sticky left-0 inline-flex items-center gap-3 px-3">
              <span className="whitespace-pre">@@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</span>
              {hunkAction && hunkAction(hi)}
            </span>
          </div>
          <div className="grid" style={{ gridTemplateColumns: wrap ? "4ch 4ch minmax(0,1fr)" : "4ch 4ch max-content" }}>
            {rows.map((r, ri) => {
              // A review comment thread anchored to this line, rendered right
              // under it as a row spanning every column — GitHub's placement, so
              // the note sits with the code it is about instead of at the far
              // bottom of the file.
              const after = rowAfter?.(r.newN, r.oldN);
              return (
                <div key={ri} className="contents">
                  <div className="text-right pr-1.5 tabular-nums select-none sticky z-[1]" style={{ left: 0, background: numBg(r.kind) }}><span className="opacity-40">{r.oldN ?? ""}</span></div>
                  <div className="text-right pr-1.5 tabular-nums select-none sticky z-[1] agx-gutter" style={{ left: "4ch", background: numBg(r.kind), boxShadow: "1px 0 0 0 color-mix(in srgb, var(--border) 22%, transparent)" }}>
                    <LineBtn n={r.newN ?? r.oldN} side={r.newN != null ? "RIGHT" : "LEFT"} onPick={onPick} />
                    <span className="opacity-40">{r.newN ?? ""}</span>
                  </div>
                  {/* `data-ln` names the row the way a search result does —
                      "R412", "L88" — so a hit found across every file has
                      somewhere to scroll to. Side follows the same rule the
                      matcher uses: a removal exists on the left, everything
                      else is reported where the reader will look for it. */}
                  <div data-ln={r.newN != null ? `R${r.newN}` : r.oldN != null ? `L${r.oldN}` : undefined}
                    className={`${wrapCls} px-1.5`} style={{ background: inSel(sel ?? null, r.newN, "RIGHT") || inSel(sel ?? null, r.oldN, "LEFT") ? "color-mix(in srgb, var(--primary) 20%, transparent)" : cellBg(r.kind), color: cellFg(r.kind) }}>
                    <span className="select-none opacity-60">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "} </span><Code text={r.text} segs={r.segs} kind={r.kind} />
                  </div>
                  {after && <div style={{ gridColumn: "1 / -1" }}>{after}</div>}
                </div>
              );
            })}
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
export function splitRows(h: DiffHunk): { l: Cell | null; r: Cell | null }[] {
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
    if (line.startsWith("\\")) continue; // no-newline marker, not a line — see unifiedRows
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
export function SplitDiff({ c, wrap, rowAfter, onPick, sel }: { c: FileChange; wrap: boolean; rowAfter?: (newN: number | null | undefined, oldN: number | null | undefined) => React.ReactNode; onPick?: (p: LinePick) => void; sel?: LineSel }) {
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
        <div data-hunk className="z-10 py-0.5 t-dim2 whitespace-pre" style={{ position: "var(--agx-hunk-pos, sticky)" as React.CSSProperties["position"], top: "var(--agx-hunk-top, 0px)", background: "color-mix(in srgb, var(--info) 12%, var(--bg))" }}>
          <span className="sticky left-0 inline-block px-3">@@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</span>
        </div>
        {rows.map((row, ri) => {
          const cell = which === "l" ? row.l : row.r;
          // Anchor on the NEW-side line so both columns place the comment at the
          // same row index and stay aligned. The two columns are independent
          // scrollers with synced vertical scroll, so the left renders an
          // invisible copy of the same height — without it the columns would
          // drift apart below the comment.
          const after = rowAfter?.(row.r?.num, row.l?.num);
          return (
            <Fragment key={ri}>
              <div data-ln={cell ? `${which === "l" ? "L" : "R"}${cell.num}` : undefined}
                className="flex" style={{ minWidth: "100%", background: cell ? cellBg(cell.kind) : HATCH }}>
                <div data-side={which} className="text-right pr-1.5 tabular-nums select-none shrink-0 sticky left-0 z-[1] agx-gutter" style={{ width: "3.6ch", background: numBg(cell?.kind), boxShadow: "1px 0 0 0 color-mix(in srgb, var(--border) 22%, transparent)" }}>
                  <LineBtn n={cell?.num} side={which === "l" ? "LEFT" : "RIGHT"} onPick={onPick} />
                  <span className="opacity-40">{cell?.num ?? ""}</span>
                </div>
                <div className={`${wrapCls} px-1.5`} style={{ color: cellFg(cell?.kind), background: inSel(sel ?? null, cell?.num, which === "l" ? "LEFT" : "RIGHT") ? "color-mix(in srgb, var(--primary) 20%, transparent)" : undefined }}>{cell ? <Code text={cell.text} segs={cell.segs} kind={cell.kind} /> : ""}</div>
              </div>
              {after && (which === "l" ? <div aria-hidden style={{ visibility: "hidden" }}>{after}</div> : after)}
            </Fragment>
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
            <div data-hunk className="z-10 px-3 py-0.5 t-dim2 whitespace-pre" style={{ position: "var(--agx-hunk-pos, sticky)" as React.CSSProperties["position"], top: "var(--agx-hunk-top, 0px)", background: "color-mix(in srgb, var(--info) 12%, var(--bg))" }}>
              @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
            </div>
            <div className="grid" style={{ gridTemplateColumns: "3.6ch minmax(0,1fr) 3.6ch minmax(0,1fr)" }}>
              {rows.map((row, ri) => {
                const after = rowAfter?.(row.r?.num, row.l?.num);
                return (
                  <div key={ri} className="contents">
                    <div data-side="l" className="text-right pr-1.5 tabular-nums select-none" style={{ background: row.l ? cellBg(row.l.kind) : HATCH }}><span className="opacity-40">{row.l?.num ?? ""}</span></div>
                    <div data-side="l" data-ln={row.l ? `L${row.l.num}` : undefined} className="whitespace-pre-wrap break-all px-1.5" style={{ background: row.l ? cellBg(row.l.kind) : HATCH, color: cellFg(row.l?.kind) }}>{row.l ? <Code text={row.l.text} segs={row.l.segs} kind={row.l.kind} /> : ""}</div>
                    <div data-side="r" className="text-right pr-1.5 tabular-nums select-none border-l" style={{ background: row.r ? cellBg(row.r.kind) : HATCH, borderColor: "color-mix(in srgb, var(--text) 16%, transparent)" }}><span className="opacity-40">{row.r?.num ?? ""}</span></div>
                    <div data-side="r" data-ln={row.r ? `R${row.r.num}` : undefined} className="whitespace-pre-wrap break-all px-1.5" style={{ background: row.r ? cellBg(row.r.kind) : HATCH, color: cellFg(row.r?.kind) }}>{row.r ? <Code text={row.r.text} segs={row.r.segs} kind={row.r.kind} /> : ""}</div>
                    {after && <div style={{ gridColumn: "1 / -1" }}>{after}</div>}
                  </div>
                );
              })}
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
      <div ref={rightRef} data-side="r" data-vscroll className="agx-scroll flex-1 min-w-0 border-l" style={{ overflow: "auto", borderColor: "color-mix(in srgb, var(--text) 16%, transparent)" }} onScroll={syncTop}>
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

type GroupBy = "worktree" | "session" | "agent" | "folder" | "tool";
const GROUP_DIMS: { id: GroupBy; label: string }[] = [
  { id: "worktree", label: "Worktree" },
  { id: "session", label: "Session" },
  { id: "agent", label: "Agent" },
  { id: "folder", label: "Folder" },
  { id: "tool", label: "Tool" },
];
type FileGroup = { key: string; label: string; sub?: string; /** Set when split by day, so the list can head each run of groups. */ day?: string; items: FileChange[]; add: number; del: number };

const dirOf = (path: string) => {
  const base = path.split("/").pop() ?? "";
  return path.slice(0, path.length - base.length).replace(/\/+$/, "") || "./";
};
/** The worktree a path lives in — the longest repo root that prefixes it, so a
 *  linked worktree wins over the parent checkout it was cut from. */
function repoForPath(path: string, repos?: GitRepoRef[]): GitRepoRef | null {
  let best: GitRepoRef | null = null;
  for (const r of repos ?? []) {
    if ((path === r.root || path.startsWith(r.root + "/")) && (!best || r.root.length > best.root.length)) best = r;
  }
  return best;
}
const shortDir = (dir: string) => {
  if (dir === "./") return "./";
  const segs = dir.split("/").filter(Boolean);
  return segs.length <= 2 ? dir.replace(/^\//, "") : "…/" + segs.slice(-2).join("/");
};

/** Bucket the (already path-filtered) changes into groups, preserving first-seen
 *  order — the API returns newest-first, so recent activity floats to the top. */
/** "Today" / "Yesterday" / "Tuesday" for the last week, then a plain date.
 *  A weekday is how you actually remember recent work; past that it stops
 *  being unambiguous and the date is the only honest label. */
function dayLabel(d: Date): string {
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/**
 * Group by a dimension, optionally split by day first.
 *
 * Date was one of the mutually exclusive dimensions, which made it useless in
 * practice: choosing it told you *when* and took away *who* — a day's worth of
 * edits with no session, agent or folder to make sense of them. It is a second
 * axis, not a fifth option, so it layers: sections stay Session (or Agent, or
 * Folder), and each one is scoped to a day when the split is on.
 */
function groupChanges(list: FileChange[], by: GroupBy, titles?: ReadonlyMap<string, string>, byDate = false, repos?: GitRepoRef[]): FileGroup[] {
  const map = new Map<string, FileGroup>();
  const order: string[] = [];
  for (const c of list) {
    let key: string, label: string, sub: string | undefined;
    if (by === "worktree") {
      // The branch is what the work is called; the folder is where it sits.
      // Group by the checkout, headed by its branch, so every change lands
      // under the worktree it belongs to and nothing spills into "the fleet".
      const r = repoForPath(c.file_path, repos);
      key = r ? r.root : "~outside";
      label = r ? (r.branch || r.name) : "Outside any worktree";
      sub = r ? (r.root.split("/").filter(Boolean).pop() ?? undefined) : undefined;
    }
    else if (by === "session") {
      key = `${c.source_app}:${c.session_id}`;
      // Named if the session has a name. Grouping by "session" and then
      // labelling each group with a uuid means reading hex to tell two
      // groups apart, which is the one thing the grouping was meant to
      // save you from.
      label = titles?.get(c.session_id) ?? agentKey({ source_app: c.source_app, session_id: c.session_id });
      sub = c.source_app;
    }
    else if (by === "agent") { key = c.source_app || "—"; label = c.source_app || "Unknown"; }
    else if (by === "tool") { key = c.tool || "—"; label = c.tool || "Unknown"; }
    else { const d = dirOf(c.file_path); key = d; label = shortDir(d); }
    // The day, when the split is on, is part of the identity — so one session
    // spanning midnight becomes two sections rather than one that lies about
    // which day it belongs to. `day` also rides along so the list can draw a
    // heading when it changes.
    let day: string | undefined;
    if (byDate) {
      const d = new Date(c.timestamp);
      day = dayLabel(d);
      key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}|${key}`;
    }
    let g = map.get(key);
    if (!g) { g = { key, label, sub, day, items: [], add: 0, del: 0 }; map.set(key, g); order.push(key); }
    g.items.push(c); g.add += c.additions; g.del += c.deletions;
  }
  // Newest first *within* a group, stated rather than inherited. The rows
  // arrive in timestamp order today, so this changes nothing — until something
  // upstream reorders them and a day's work silently stops reading
  // chronologically, which is the one thing a date grouping is for.
  for (const g of map.values()) g.items.sort((a, b) => b.timestamp - a.timestamp);
  return order.map((k) => map.get(k)!);
}

function TypeTag({ c, override }: { c: FileChange; override?: string }) {
  const label = override ? override.toUpperCase() : fileType(c).label;
  const color = TYPE_STYLE[label] ?? fileType(c).color;
  return <span className="chip shrink-0 text-[10px] tracking-wide" style={{ color, background: `color-mix(in srgb, ${color} 15%, transparent)` }}>{label}</span>;
}

function ReviewDot({ on, onClick, title }: { on: boolean; onClick?: (e: React.MouseEvent) => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[10px] leading-none transition-colors"
      style={{
        color: on ? "var(--success)" : "var(--text3)",
        border: `1px solid ${on ? "color-mix(in srgb, var(--success) 70%, transparent)" : "color-mix(in srgb, var(--border) 55%, transparent)"}`,
        background: on ? "color-mix(in srgb, var(--success) 18%, transparent)" : "transparent",
      }}
    >{on ? "✓" : ""}</button>
  );
}

/**
 * One file, however many times it was written.
 *
 * An agent does not edit a file once. It writes it, runs the tests, fixes the
 * assertion, fixes the import — and a section that was meant to say "what
 * happened here" says `test_cancellation_lockout.py` four times in a row with
 * four sets of numbers, and the file you are looking for is somewhere in the
 * repetition. On a real session: 122 rows, 76 of them the same handful of paths.
 *
 * Folding is by PATH and keeps every edit, which is the part that matters — the
 * individual diffs are still there, one click down, in the order they happened.
 * Nothing is summed away that cannot be reopened.
 */
type FileStack = { path: string; items: FileChange[]; add: number; del: number };

function stackByPath(items: FileChange[]): FileStack[] {
  const map = new Map<string, FileStack>();
  const order: string[] = [];
  for (const c of items) {
    let s = map.get(c.file_path);
    if (!s) { s = { path: c.file_path, items: [], add: 0, del: 0 }; map.set(c.file_path, s); order.push(c.file_path); }
    s.items.push(c); s.add += c.additions; s.del += c.deletions;
  }
  return order.map((p) => map.get(p)!);
}

function FileItem({ c, active, reviewed, onSelect, onToggleReviewed }: { c: FileChange; active: boolean; reviewed: boolean; onSelect: () => void; onToggleReviewed: () => void }) {
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
        <TypeTag c={c} />
        <span className="text-[11.5px] font-medium truncate" style={{ color: reviewed ? "var(--text3)" : "var(--text)" }}>{base}</span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0 text-[10px] tabular-nums">
          {c.additions > 0 && <span style={{ color: "var(--success)" }}>+{c.additions}</span>}
          {c.deletions > 0 && <span style={{ color: "var(--error)" }}>−{c.deletions}</span>}
        </span>
      </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[9.5px] t-dim2 pl-[22px]">
          <span className="truncate min-w-0" title={c.file_path}>{dirOf(c.file_path)}</span>
          <span className="ml-auto shrink-0 opacity-80">{c.tool}</span>
          <span className="shrink-0">{fmtTime(c.timestamp)}</span>
        </div>
    </div>
  );
}

/**
 * A file that was touched more than once, as one row that opens.
 *
 * Selecting it opens the LATEST edit, which is what somebody clicking a
 * filename means — the state it ended in. The earlier ones are a click away and
 * keep their own numbers, so "unify" never means "lose".
 *
 * The count is drawn where the diff totals are, in the same tabular figures,
 * because it is the same kind of fact: how much happened here.
 */
function FileStackItem({ s, open, selId, reviewed, onOpen, onSelect, onToggleReviewed, onToggleAll }: {
  s: FileStack; open: boolean; selId: number | null; reviewed: Set<number>;
  onOpen: () => void; onSelect: (id: number) => void; onToggleReviewed: (id: number) => void;
  onToggleAll: (s: FileStack, next: boolean) => void;
}) {
  const base = s.path.split("/").pop();
  const newest = s.items[0]!;
  const holdsSel = s.items.some((c) => c.id === selId);
  const allRev = s.items.every((c) => reviewed.has(c.id));
  /*
   * Opens itself when the selection is one of the edits UNDERNEATH it.
   *
   * j/k walk every change, folded or not, so they can land inside a stack — and
   * a folded row cannot show which of its four edits is selected. Left closed,
   * the cursor moves and nothing on screen does, which reads as a stuck key.
   * Clicking the row still opens the newest without unfolding, because that is
   * a different intent: "show me this file", not "walk through it".
   */
  const showKids = open || (holdsSel && selId !== newest.id);
  return (
    <div>
      <div
        data-file={holdsSel && !showKids ? "active" : undefined}
        role="button"
        tabIndex={-1}
        onClick={() => onSelect(newest.id)}
        className="w-full text-left rounded-lg px-2 py-1.5 transition-colors cursor-pointer"
        style={{
          background: holdsSel ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
          border: `1px solid ${holdsSel ? "color-mix(in srgb, var(--primary) 32%, transparent)" : "transparent"}`,
        }}
      >
        <div className="flex items-center gap-1.5">
          <ReviewDot on={allRev} onClick={(e) => { e.stopPropagation(); onToggleAll(s, !allRev); }}
            title={allRev ? `Mark all ${s.items.length} unreviewed` : `Mark all ${s.items.length} reviewed`} />
          <TypeTag c={newest} />
          <span className="text-[11.5px] font-medium truncate" style={{ color: allRev ? "var(--text3)" : "var(--text)" }}>{base}</span>
          {/* The whole point of the row, so it is the one thing with a shape:
              a filled pill among flat numbers. */}
          <button
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            title={open ? "Hide the individual edits" : `Show all ${s.items.length} edits, oldest last`}
            className="shrink-0 flex items-center gap-0.5 text-[9.5px] tabular-nums rounded-full px-1.5 leading-[15px] transition-colors"
            style={{
              color: "var(--primary)",
              background: "color-mix(in srgb, var(--primary) 15%, transparent)",
              border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)",
            }}
          >
            <span>×{s.items.length}</span>
            <span aria-hidden className="transition-transform" style={{ transform: open ? "rotate(90deg)" : "none", opacity: 0.75 }}>›</span>
          </button>
          <span className="ml-auto flex items-center gap-1.5 shrink-0 text-[10px] tabular-nums">
            {s.add > 0 && <span style={{ color: "var(--success)" }}>+{s.add}</span>}
            {s.del > 0 && <span style={{ color: "var(--error)" }}>−{s.del}</span>}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[9.5px] t-dim2 pl-[22px]">
          <span className="truncate min-w-0" title={s.path}>{dirOf(s.path)}</span>
          {/* When it started and when it stopped: the span is the thing a
              folded row hides, and the one worth keeping. */}
          <span className="ml-auto shrink-0">
            {s.items.length > 1
              ? `${fmtTime(s.items[s.items.length - 1]!.timestamp)} → ${fmtTime(newest.timestamp)}`
              : fmtTime(newest.timestamp)}
          </span>
        </div>
      </div>
      {showKids && (
        // Indented and hairlined, so an expanded stack cannot be mistaken for
        // the flat list it just replaced.
        <div className="mt-0.5 space-y-0.5 pl-3 ml-2"
          style={{ borderLeft: "1px solid color-mix(in srgb, var(--primary) 25%, transparent)" }}>
          {s.items.map((c) => (
            <FileItem key={c.id} c={c} active={c.id === selId} reviewed={reviewed.has(c.id)}
              onSelect={() => onSelect(c.id)} onToggleReviewed={() => onToggleReviewed(c.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function GroupBlock({ g, collapsed, selId, reviewed, fold, onToggleCollapse, onSelect, onToggleReviewed, onToggleGroup }: {
  g: FileGroup; collapsed: boolean; selId: number | null; reviewed: Set<number>;
  /** One row per file rather than one per edit. See stackByPath. */
  fold: boolean;
  onToggleCollapse: () => void; onSelect: (id: number) => void; onToggleReviewed: (id: number) => void; onToggleGroup: (g: FileGroup, next: boolean) => void;
}) {
  /* Which stacks the reader has opened. Kept per group and forgotten when the
     fold is switched off, because it describes a shape that no longer exists. */
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const stacks = useMemo(() => (fold ? stackByPath(g.items) : []), [fold, g.items]);
  const revCount = g.items.reduce((n, c) => n + (reviewed.has(c.id) ? 1 : 0), 0);
  const allRev = revCount === g.items.length;
  return (
    <div className="mb-1">
      {/* Two rows, not one. Grouping by session finally shows real names, and a
          real name is a sentence — "Call duration is not showing for some UR
          (unresponsive) calls" — which cannot share a 300px row with the repo,
          a file count and two diff totals without being cut to "Call duration
          is …". The name gets the full width and up to two lines; everything
          numeric drops underneath, where it still reads fine. */}
      <div className="flex items-start gap-1.5 px-1.5 py-1 rounded-md" style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)" }}>
        <button onClick={onToggleCollapse} className="flex items-start gap-1.5 min-w-0 flex-1 text-left">
          <span className="text-[10px] t-dim2 transition-transform shrink-0 mt-[3px]" style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}>▾</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-semibold leading-snug" title={g.label}
              style={{ color: "var(--text2, var(--text))", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>
              {g.label}
            </span>
            <span className="flex items-center gap-1.5 text-[9.5px] tabular-nums mt-0.5">
              {g.sub && <span className="t-dim2 truncate">{g.sub}</span>}
              <span className="t-dim2">{g.items.length}</span>
              {g.add > 0 && <span style={{ color: "var(--success)" }}>+{g.add}</span>}
              {g.del > 0 && <span style={{ color: "var(--error)" }}>−{g.del}</span>}
            </span>
          </span>
        </button>
        <button
          onClick={() => onToggleGroup(g, !allRev)}
          title={allRev ? "Mark group unreviewed" : "Mark whole group reviewed"}
          className="shrink-0 text-[10px] tabular-nums px-1 rounded hover:opacity-80"
          style={{ color: allRev ? "var(--success)" : "var(--text3)" }}
        >{revCount}/{g.items.length}</button>
      </div>
      {!collapsed && (
        <div className="mt-0.5 space-y-0.5">
          {fold
            ? stacks.map((s) => (
                s.items.length === 1
                  // One edit is not a stack, and dressing it as one would put a
                  // "×1" on most rows to solve a problem they do not have.
                  ? <FileItem key={s.path} c={s.items[0]!} active={s.items[0]!.id === selId} reviewed={reviewed.has(s.items[0]!.id)}
                      onSelect={() => onSelect(s.items[0]!.id)} onToggleReviewed={() => onToggleReviewed(s.items[0]!.id)} />
                  : <FileStackItem key={s.path} s={s} open={opened.has(s.path)} selId={selId} reviewed={reviewed}
                      onOpen={() => setOpened((o) => { const n = new Set(o); n.has(s.path) ? n.delete(s.path) : n.add(s.path); return n; })}
                      onSelect={onSelect} onToggleReviewed={onToggleReviewed}
                      onToggleAll={(st, next) => { for (const c of st.items) if (reviewed.has(c.id) !== next) onToggleReviewed(c.id); }} />
              ))
            : g.items.map((c) => (
                <FileItem key={c.id} c={c} active={c.id === selId} reviewed={reviewed.has(c.id)} onSelect={() => onSelect(c.id)} onToggleReviewed={() => onToggleReviewed(c.id)} />
              ))}
        </div>
      )}
    </div>
  );
}

// --- controls ----------------------------------------------------------------
// Syntax-theme dropdown (Shiki). "auto" follows the app's light/dark; the rest
// mirror the user's Neovim themes. Grouped dark/light, closes on outside click.
export function ThemePicker({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string | null }) {
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
        title={error || "Syntax theme"}
        className="px-2 py-0.5 rounded-md text-[10px] transition-colors flex items-center gap-1"
        style={{
          background: error ? "color-mix(in srgb, var(--warning) 16%, transparent)" : "color-mix(in srgb, var(--bg3) 45%, transparent)",
          border: `1px solid color-mix(in srgb, var(--${error ? "warning" : "border"}) ${error ? 55 : 30}%, transparent)`,
          color: error ? "var(--warning)" : "var(--text3)",
        }}
      >
        {/* The label names the theme the user picked, so when that theme could
            not be loaded the button has to say so — otherwise it vouches for
            colors that aren't on screen. */}
        {error && <span aria-hidden>⚠</span>}
        <span className="truncate" style={{ maxWidth: 92 }}>{label}</span>
        <span style={{ opacity: 0.6, fontSize: 10 }}>▼</span>
      </button>
      {/* zIndex must beat the diff's sticky hunk headers, which are also z-20:
          on a tie the later-painted element wins, so those headers were
          striping grey bars across this list wherever a `@@ … @@` line sat
          behind it. */}
      {open && (
        <div
          className="agx-scroll absolute right-0 mt-1 rounded-lg py-1 text-[10.5px] shadow-2xl"
          style={{ zIndex: 40, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--text) 24%, transparent)", minWidth: 178, maxHeight: 340, overflowY: "auto" }}
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
// This view is a rolling history of edits — today, yesterday, a few days back —
// not an all-time archive. HISTORY_DAYS is the window; HISTORY_LIMIT is how many
// recent edits to pull so the window is actually filled on a busy fleet (the
// server caps it at 500).
const HISTORY_DAYS = 5;
const HISTORY_LIMIT = 500;
// The git side of the view: "working" — uncommitted changes + the edit history;
// "committed" — each worktree's last commit only, so what you committed does not
// vanish with the working tree.
const GITMODE_KEY = "agentglass.diffGitMode";
// v2: the default became "worktree" when File changes started grouping by the
// checkout an edit is in. Bumped so a stored "session" from before doesn't
// override it — everyone starts on the new default and re-persists their choice.
const GROUPBY_KEY = "agentglass.diffGroupBy.v2";
/** Remembered, because it is a way of reading rather than a one-off question. */
const FOLD_KEY = "agentglass.diffFoldFiles";
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

type DiffViewProps = {
  active: boolean;
  onClose?: () => void;
  onBack?: () => void;
  backLabel?: string;
  presetChanges?: FileChange[];
  presetTitle?: string;
  presetPath?: string;
};

/** The file-changes viewer, without a frame around it.
 *
 *  Two callers with two different shapes: the workspace mounts it as the
 *  `diff` view (no chrome — the rail is the chrome), and GitPanel still opens
 *  it as a modal to drill into one commit. Hence `DiffView` plus the
 *  `ChangesModal` wrapper at the bottom of this file. */
export function DiffView({ active, onClose, onBack, backLabel, presetChanges, presetTitle, presetPath }: DiffViewProps) {
  const sidebarW = useSidebarWidth();
  const open = active;
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  // Each in-scope worktree's uncommitted changes (git), shown next to the edit
  // history so what a checkout actually changed is there even when no agent
  // recorded it. Plus the repo list, to group everything by worktree.
  const [gitChanges, setGitChanges] = useState<FileChange[]>([]);
  const [gitMode, setGitMode] = useState<"working" | "committed">(() => {
    try { return localStorage.getItem(GITMODE_KEY) === "committed" ? "committed" : "working"; } catch { return "working"; }
  });
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [q, setQ] = useState("");
  /** Ignored files start folded away — see `visible` below. */
  const [showIgnored, setShowIgnored] = useState(false);
  const [showOutside, setShowOutside] = useState(false);
  /** What the server filtered against, so the chip names the same project the
   *  flag was computed from. Null on an unscoped instance. */
  const [project, setProject] = useState<string | null>(null);
  /** Split whichever grouping is chosen by day as well. */
  const [byDate, setByDate] = useState(false);
  const [fold, setFold] = useState(() => {
    try { return localStorage.getItem(FOLD_KEY) === "1"; } catch { return false; }
  });
  const [selId, setSelId] = useState<number | null>(null);
  const [wrap, setWrap] = useState(diffWrap);
  const [split, setSplit] = useState(diffSplit);
  const [copied, setCopied] = useState<null | "path" | "diff">(null);
  /** A file being read whole, over the modal. */
  const [peek, setPeek] = useState<Peek | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    try { const v = localStorage.getItem(GROUPBY_KEY); if (v === "worktree" || v === "session" || v === "agent" || v === "folder" || v === "tool") return v as GroupBy; } catch { /* ignore */ }
    return "worktree";
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [reviewed, setReviewed] = useState<Set<number>>(() => new Set());
  const paneRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const wtJump = useSyncExternalStore(subscribeWorktreeJump, worktreeJump);
  const wtJumpServed = useRef(0);

  useEffect(() => {
    if (!open) return;
    setChanges(null);
    setGitChanges([]);
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
      api.changes(HISTORY_LIMIT).then((r) => {
        setChanges(r.changes);
        setProject(r.project ?? null);
        setSelId(r.changes[0]?.id ?? null);
      }).catch(() => setChanges([]));
      // The repos, to group by worktree. The git side (working tree, or the last
      // commit) is fetched by its own mode-dependent effect below.
      api.gitRepos().then((r) => setRepos(r.repos)).catch(() => { /* grouping falls back to "outside" */ });
    }
    // Session names, so grouping by session shows what each one is rather than
    // a uuid. Fetched here rather than passed in: this modal is opened from
    // several places (the fleet, a session, the git panel) and threading a prop
    // through all of them to display a label isn't worth the coupling.
    api.sessions(200).then((ss) => setTitles(buildTitles(ss))).catch(() => { /* labels fall back to the uuid */ });
    // focus the frame so j/k nav works immediately (filter is opt-in via click)
    requestAnimationFrame(() => frameRef.current?.focus());
  }, [open]);

  // The git side — the working tree, or each worktree's last commit — refetched
  // whenever the mode toggles (the poll keeps it fresh after). Its own effect so
  // flipping the toggle does not reset the filter, selection or collapsed groups
  // the way re-running the open effect would.
  useEffect(() => {
    if (!open || presetChanges) return;
    try { localStorage.setItem(GITMODE_KEY, gitMode); } catch { /* ignore */ }
    let gone = false;
    api.gitChangesAll(gitMode).then((r) => { if (!gone) setGitChanges(r.changes); }).catch(() => { if (!gone) setGitChanges([]); });
    return () => { gone = true; };
  }, [open, gitMode, presetChanges]);

  // A worktree jump from the Terminal chrome seeds the file-path filter with the
  // worktree's folder name. Declared after the open-reset above (which clears
  // the filter every time this view is shown) and depending on `open` so it
  // re-applies in the same pass the view becomes active — and served once per
  // request `n`, so re-opening File changes later never replays a stale filter.
  useEffect(() => {
    if (!open) return;
    if (wtJump && wtJump.view === "diff" && wtJump.filter != null && wtJump.n !== wtJumpServed.current) {
      wtJumpServed.current = wtJump.n;
      setQ(wtJump.filter);
    }
  }, [open, wtJump]);

  // The fleet keeps editing while this is open, so a list loaded once goes
  // stale within a turn. Refreshed in place rather than through the effect
  // above: that one resets the filter, the collapsed groups and the selection,
  // which would yank the file out from under you mid-read every few seconds.
  //
  // Not polled for a preset changeset — those are one session's changes, handed
  // in already resolved, and re-fetching would replace them with the fleet's.
  usePoll(open && !presetChanges, () => {
    api.changes(HISTORY_LIMIT).then((r) => {
      setProject(r.project ?? null);
      setChanges((prev) => {
        // Same ids in the same order → keep the old array so nothing downstream
        // re-renders or re-highlights on an unchanged poll.
        if (prev && prev.length === r.changes.length && prev.every((c, i) => c.id === r.changes[i].id)) return prev;
        return r.changes;
      });
      // Keep the current selection; the `selected` memo heals a vanished id to
      // the first visible row, so only seed one when there is none.
      setSelId((cur) => cur ?? r.changes[0]?.id ?? null);
    }).catch(() => { /* keep showing what we have */ });
    api.gitChangesAll(gitMode).then((r) => {
      setGitChanges((prev) =>
        prev.length === r.changes.length && prev.every((c, i) => c.id === r.changes[i].id) ? prev : r.changes);
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
  useEffect(() => { try { localStorage.setItem(FOLD_KEY, fold ? "1" : "0"); } catch { /* ignore */ } }, [fold]);

  // What this view is: each worktree's uncommitted git changes (what a checkout
  // has actually changed, now) next to the edit history (what the fleet did over
  // time). The edit log is a ROLLING window — past HISTORY_DAYS it is memory,
  // not "what's happening", and buries today under last week — so it is trimmed;
  // git rows are always current and pass through untouched. git is the truth of
  // the moment, so where a file has an uncommitted git change it wins and its
  // edit rows fold away; a file only in the log still shows.
  const all = useMemo(() => {
    // Only your branches — never the trunk checkout (master/main), the base you
    // cut from rather than something you are working on. Git rows already come
    // trunk-free from the server; the edit log does not, so drop edits living in
    // a master/main checkout here.
    const mine = (c: FileChange) => { const r = repoForPath(c.file_path, repos); return !r || (r.branch !== "master" && r.branch !== "main"); };
    // "Committed" is a clean, single answer — each worktree's last commit — so it
    // stands alone, without the edit log beside it.
    if (gitMode === "committed") return gitChanges;
    const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const edits = (changes ?? []).filter((c) => c.timestamp >= cutoff && mine(c));
    if (!gitChanges.length) return edits;
    const gitPaths = new Set(gitChanges.map((c) => c.file_path));
    return [...gitChanges, ...edits.filter((c) => !gitPaths.has(c.file_path))];
  }, [changes, gitChanges, gitMode, repos]);
  /**
   * Files git ignores are folded away by default.
   *
   * An agent's edit is recorded whether or not the repo tracks the result, so
   * build output, caches and scratch files sit in the list beside the code you
   * came to review — and on a busy session they outnumber it. Hidden, never
   * silently: the count is shown and one click brings them back, because a list
   * that quietly drops entries is worse than a long one.
   */
  /**
   * And the same for files that are not this project's.
   *
   * A session is in scope because its cwd is; where it writes is another
   * question. A cockpit scoped to one repo still fills with a note
   * under ~/Documents and a scratch script in /tmp — real edits by a real
   * session of this project, and not one of them the project. Same treatment as
   * the ignored ones for the same reason: folded away, counted, one click back.
   *
   * Each chip counts the rows IT is hiding — a file that is both ignored and
   * outside is not claimed by both, or you click "+1 outside", nothing appears,
   * and the count looks like a lie when it was the other filter still holding
   * the row down.
   */
  const outsideCount = useMemo(
    () => all.reduce((n, c) => n + (c.outside && (showIgnored || !c.ignored) ? 1 : 0), 0),
    [all, showIgnored],
  );
  const ignoredCount = useMemo(
    () => all.reduce((n, c) => n + (c.ignored && (showOutside || !c.outside) ? 1 : 0), 0),
    [all, showOutside],
  );
  const visible = useMemo(
    () => all.filter((c) => (showIgnored || !c.ignored) && (showOutside || !c.outside)),
    [all, showIgnored, showOutside],
  );
  const filtered = useMemo(() => (q ? visible.filter((c) => c.file_path.toLowerCase().includes(q.toLowerCase())) : visible), [visible, q]);
  const groups = useMemo(() => groupChanges(filtered, groupBy, titles, byDate, repos), [filtered, groupBy, titles, byDate, repos]);
  /* How many rows are a file already listed in the same section. Counted from
     the groups, not from the whole list, because that is what folding would
     actually remove — a file edited under two different sessions is two rows
     either way, and promising to fold it would be a lie. */
  const dupRows = useMemo(
    () => groups.reduce((n, g) => n + (g.items.length - new Set(g.items.map((c) => c.file_path)).size), 0),
    [groups],
  );
  const shown = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const totals = useMemo(() => all.reduce((a, c) => ({ add: a.add + c.additions, del: a.del + c.deletions }), { add: 0, del: 0 }), [all]);
  const revCount = useMemo(() => all.reduce((n, c) => n + (reviewed.has(c.id) ? 1 : 0), 0), [all, reviewed]);
  const selected = useMemo(() => shown.find((c) => c.id === selId) ?? shown[0] ?? null, [shown, selId]);
  // Shiki highlighter + theme/bold controls (shared with the git panel).
  const { hilite, themePref, setThemePref, bold, setBold, hiliteError } = useDiffHighlight(selected?.file_path);
  // Restore a cached walkthrough for the current changeset (on open / when the
  // changeset changes) so it persists across close/reopen and never re-runs.
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
    // `o` for open, beside `c` for copy: the two things you do with a path.
    else if (k === "o" && selected) { e.preventDefault(); e.stopPropagation(); setPeek({ root: rootOfPath(selected.file_path), path: selected.file_path, label: selected.file_path }); }
    else if (k === "x") { e.preventDefault(); e.stopPropagation(); if (selected) toggleReviewed(selected.id); }
  };

  return (
    <div ref={frameRef} tabIndex={-1} onKeyDown={onKey}
      className="flex-1 min-h-0 flex flex-col outline-none overflow-hidden relative">
                <style>{SCROLLBAR_CSS}</style>
                <div className={viewHeaderClass} style={viewHeaderStyle}>
                  {/* No wrapping: the bar is a fixed height now, so a second
                      line does not make it taller — it gets clipped. The meta
                      truncates instead, which loses the tail of a preset name
                      rather than half the row. */}
                  <div className="flex items-baseline gap-2.5 min-w-0">
                    <h2 className="sr-only">File changes</h2>
                    {changes && (
                      <span className="text-[10px] t-dim2 tabular-nums truncate">
                        {all.length} edits · <span style={{ color: "var(--success)" }}>+{totals.add}</span> <span style={{ color: "var(--error)" }}>−{totals.del}</span> · {presetTitle || "What the fleet changed"}
                      </span>
                    )}
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    {onBack && (
                      <button
                        onClick={onBack}
                        title={backLabel || "Back"}
                        className="text-[11px] px-2.5 py-1 rounded-lg transition-colors"
                        style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg3) 45%, transparent)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}
                      >← {backLabel || "Back"}</button>
                    )}
                    {/* "Explain" and "Commit…" lived here and are gone. Both
                        were answers to questions this view is no longer where
                        you ask: committing belongs to the Git view, which has
                        the staging area and the branch, and an AI walkthrough
                        of somebody else's changeset is a chat away. What is
                        left is what this view is actually for — reading the
                        diff — and two fewer buttons is two fewer things to
                        read past to get to it. */}
                    {/* only when framed as a modal — inside the workspace the
                        rail owns closing */}
                    {onClose && <CloseButton onClick={onClose} />}
                  </div>
                </div>


                <div className="flex-1 min-h-0 flex">
                  {/* master — grouped file list */}
                  <div className="shrink-0 flex flex-col" style={{ width: sidebarW }}>
                    <div className="p-2.5 pb-1.5 shrink-0 space-y-2">
                      <input
                        value={q} onChange={(e) => setQ(e.target.value)}
                        placeholder="Filter by file path…"
                        className="w-full px-3 py-1.5 rounded-lg text-[11px] outline-none"
                        style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", color: "var(--text)" }}
                      />
                      {/* One row, one height. `flex-wrap` rather than letting a
                          chip grow: on a narrow panel the row wraps as a row,
                          which is legible, instead of one button becoming two
                          lines tall and dragging its neighbours' baseline. */}
                      <div className="flex items-center flex-wrap gap-1">
                        {/* What the git rows are: the working tree (uncommitted,
                            beside the edit history) or each worktree's last
                            commit — so what you committed does not vanish. First,
                            because it changes what the whole list is. */}
                        {(["working", "committed"] as const).map((m) => (
                          <button
                            key={m}
                            onClick={() => setGitMode(m)}
                            className="px-1.5 py-0.5 rounded text-[9.5px] transition-colors whitespace-nowrap leading-5"
                            title={m === "working" ? "Uncommitted changes, next to the edit history" : "Each worktree's last commit — what you just committed"}
                            style={{
                              background: gitMode === m ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent",
                              color: gitMode === m ? "var(--text)" : "var(--text3)",
                              border: `1px solid color-mix(in srgb, var(--border) ${gitMode === m ? 45 : 18}%, transparent)`,
                            }}
                          >{m === "working" ? "Working" : "Committed"}</button>
                        ))}
                        <span className="w-px h-4 mx-0.5 shrink-0" style={{ background: "color-mix(in srgb, var(--border) 45%, transparent)" }} />
                        {GROUP_DIMS.map((d) => (
                          <button
                            key={d.id}
                            onClick={() => setGroupBy(d.id)}
                            className="px-1.5 py-0.5 rounded text-[9.5px] transition-colors whitespace-nowrap leading-5"
                            style={{
                              background: groupBy === d.id ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent",
                              color: groupBy === d.id ? "var(--text)" : "var(--text3)",
                              border: `1px solid color-mix(in srgb, var(--border) ${groupBy === d.id ? 45 : 18}%, transparent)`,
                            }}
                          >{d.label}</button>
                        ))}
                        {/* A modifier, not a fifth dimension — it sits after a
                            separator because it changes what the four to its
                            left do rather than replacing them. */}
                        <span className="w-px h-4 mx-0.5 shrink-0" style={{ background: "color-mix(in srgb, var(--border) 45%, transparent)" }} />
                        <button
                          onClick={() => setByDate((v) => !v)}
                          className="px-1.5 py-0.5 rounded text-[9.5px] transition-colors whitespace-nowrap leading-5"
                          title={byDate ? "One section per group" : "Split each group by day"}
                          style={{
                            background: byDate ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent",
                            color: byDate ? "var(--text)" : "var(--text3)",
                            border: `1px solid color-mix(in srgb, var(--border) ${byDate ? 45 : 18}%, transparent)`,
                          }}
                        >By date</button>
                        {/*
                          * Carries its own reason: the number is how many rows
                          * folding would take away, so the button answers "is
                          * this worth pressing" before it is pressed — and
                          * disappears entirely when the answer is no.
                          *
                          * Filled rather than outlined when on, unlike the four
                          * dimensions beside it, because this one changes the
                          * SHAPE of the list rather than its order, and that is
                          * worth telling apart at a glance.
                          */}
                        {dupRows > 0 && (
                          <button
                            onClick={() => setFold((v) => !v)}
                            aria-pressed={fold}
                            className="px-1.5 py-0.5 rounded text-[9.5px] transition-colors whitespace-nowrap leading-5 flex items-center gap-1"
                            title={fold
                              ? "Show every edit as its own row again"
                              : `${dupRows} row${dupRows === 1 ? "" : "s"} repeat a file already listed — fold each file into one, keeping every edit a click away`}
                            style={fold
                              ? { background: "color-mix(in srgb, var(--primary) 30%, transparent)", color: "var(--text)",
                                  border: "1px solid color-mix(in srgb, var(--primary) 60%, transparent)" }
                              : { background: "transparent", color: "var(--text3)",
                                  border: "1px solid color-mix(in srgb, var(--border) 18%, transparent)" }}
                          >
                            {/* Three lines becoming one — the operation, drawn.
                                A glyph would have been a speck at this size;
                                this is 9 real pixels of stroke. */}
                            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 10 10" fill="none" aria-hidden className="shrink-0">
                              <path d={fold ? "M1 2h8M1 5h8M1 8h8" : "M1 5h8M2.5 2.2h5M2.5 7.8h5"}
                                stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                            </svg>
                            <span>One row per file</span>
                            {!fold && <span className="tabular-nums" style={{ opacity: 0.7 }}>−{dupRows}</span>}
                          </button>
                        )}
                        {/* Says what it is hiding, and offers it back. A
                            filter that silently drops rows makes the list lie
                            about what the session touched. */}
                        {ignoredCount > 0 && (
                          <button
                            onClick={() => setShowIgnored((v) => !v)}
                            // nowrap: "+ 23 ignored" broke across two lines and
                            // made this chip taller than the four beside it.
                            // A button that changes height with its own label
                            // is never worth the width it saves.
                            className="px-1.5 py-0.5 rounded text-[9.5px] transition-colors whitespace-nowrap leading-5"
                            title={showIgnored
                              ? "Hide files git ignores"
                              : `${ignoredCount} file${ignoredCount === 1 ? "" : "s"} git ignores ${ignoredCount === 1 ? "is" : "are"} hidden — build output, caches, scratch files`}
                            style={{
                              background: showIgnored ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent",
                              color: showIgnored ? "var(--text)" : "var(--text3)",
                              border: `1px solid color-mix(in srgb, var(--border) ${showIgnored ? 45 : 18}%, transparent)`,
                            }}
                          >{showIgnored ? `✕ ${ignoredCount} ignored` : `+ ${ignoredCount} ignored`}</button>
                        )}
                        {/* Only when there is a project to be outside of, and
                            only when something actually is. Named, because
                            "outside" alone raises the question this answers:
                            outside WHAT. */}
                        {outsideCount > 0 && (
                          <button
                            onClick={() => setShowOutside((v) => !v)}
                            className="px-1.5 py-0.5 rounded text-[9.5px] transition-colors whitespace-nowrap leading-5"
                            title={showOutside
                              ? `Hide edits outside ${project ?? "this project"}`
                              : `${outsideCount} file${outsideCount === 1 ? "" : "s"} outside ${project ?? "this project"} ${outsideCount === 1 ? "is" : "are"} hidden — notes, scratch files, anything this project's sessions touched elsewhere`}
                            style={{
                              background: showOutside ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent",
                              color: showOutside ? "var(--text)" : "var(--text3)",
                              border: `1px solid color-mix(in srgb, var(--border) ${showOutside ? 45 : 18}%, transparent)`,
                            }}
                          >{showOutside ? `✕ ${outsideCount} outside` : `+ ${outsideCount} outside`}</button>
                        )}
                        {changes && all.length > 0 && (
                          <span className="ml-auto text-[9.5px] t-dim2 tabular-nums" title="Files reviewed">{revCount}/{visible.length}</span>
                        )}
                      </div>
                    </div>
                    <div className="agx-scroll flex-1 min-h-0 overflow-y-auto px-2 pb-2">
                      {!changes && <div className="t-dim2 text-center py-10 text-[12px]">Loading changes…</div>}
                      {changes && shown.length === 0 && <div className="t-dim2 text-center py-10 text-[12px]">{q ? "No files match your filter" : "No file changes captured yet"}</div>}
                      {groups.map((g, gi) => (
                        <div key={`w:${g.key}`}>
                          {/* Only when it changes: repeating "Today" above every
                              session turns a heading into wallpaper. */}
                          {g.day && g.day !== groups[gi - 1]?.day && (
                            <div className="px-1 pt-2 pb-1 text-[10px] uppercase tracking-wider" style={{ color: "var(--primary-hover)" }}>{g.day}</div>
                          )}
                        <GroupBlock
                          key={g.key}
                          g={g}
                          collapsed={collapsed.has(g.key) && !q}
                          selId={selected?.id ?? null}
                          reviewed={reviewed}
                          fold={fold}
                          onToggleCollapse={() => toggleCollapse(g.key)}
                          onSelect={select}
                          onToggleReviewed={toggleReviewed}
                          onToggleGroup={toggleGroup}
                        />
                        </div>
                      ))}
                    </div>
                  </div>
                  <SidebarGrip />

                  {/* detail — full diff */}
                  <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                    {selected ? (
                      <>
                        <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--text) 16%, transparent)" }}>
                          <span className="text-[12px] font-medium truncate" style={{ color: "var(--text)" }} title={selected.file_path}>{selected.file_path}</span>
                          <span className="shrink-0 text-[10.5px] tabular-nums flex items-center gap-1.5">
                            {selected.additions > 0 && <span style={{ color: "var(--success)" }}>+{selected.additions}</span>}
                            {selected.deletions > 0 && <span style={{ color: "var(--error)" }}>−{selected.deletions}</span>}
                          </span>
                          <div className="ml-auto flex items-center gap-1.5 shrink-0">
                            <Toggle on={reviewed.has(selected.id)} onClick={() => toggleReviewed(selected.id)} title="Mark this file reviewed (x)">{reviewed.has(selected.id) ? "Reviewed ✓" : "Review"}</Toggle>
                            <Toggle on={split} onClick={() => setSplit((s) => !s)} title="Split / unified">{split ? "Split" : "Unified"}</Toggle>
                            <Toggle on={wrap} onClick={() => setWrap((w) => !w)} title="Toggle line wrap (w)">Wrap</Toggle>
                            <ThemePicker value={themePref} onChange={setThemePref} error={hiliteError} />
                            <Toggle on={bold} onClick={() => setBold((b) => !b)} title="Bold keywords, functions & types (Neovim-style)">Bold</Toggle>
                            {/* The diff answers what changed. When the answer is
                                in what did not — the function above, the import
                                at the top — this is the way to it, on the file
                                already selected, without going to find a
                                terminal and putting it in the right checkout. */}
                            <Toggle onClick={() => setPeek({ root: rootOfPath(selected.file_path), path: selected.file_path, label: selected.file_path })}
                              title="Open the whole file in an editor (o)">⧉ Open</Toggle>
                            <Toggle onClick={() => copy("path")} title="Copy file path (c)">{copied === "path" ? "Copied ✓" : "Path"}</Toggle>
                            <Toggle onClick={() => copy("diff")} title="Copy unified diff">{copied === "diff" ? "Copied ✓" : "Diff"}</Toggle>
                          </div>
                        </div>
                        <div ref={paneRef} className="flex-1 min-h-0 flex relative" style={{ background: "var(--bg)" }}>
                          <HiliteCtx.Provider value={selected.hunks.reduce((n, h) => n + h.lines.length, 0) > 3000 ? { ...hilite, theme: null } : hilite}>{split ? <SplitDiff c={selected} wrap={wrap} /> : <UnifiedDiff c={selected} wrap={wrap} />}</HiliteCtx.Provider>
                        </div>
                        <div className="shrink-0 px-4 py-1 border-t text-[9.5px] t-dim2 flex items-center gap-3" style={{ borderColor: "color-mix(in srgb, var(--text) 16%, transparent)" }}>
                          <span><b className="font-semibold">j/k</b> file</span>
                          <span><b className="font-semibold">n/p</b> hunk</span>
                          <span><b className="font-semibold">x</b> reviewed</span>
                          <span><b className="font-semibold">w</b> wrap</span>
                          <span><b className="font-semibold">c</b> copy path</span>
                          <span><b className="font-semibold">o</b> open file</span>
                          <span className="ml-auto tabular-nums">{selected.hunks.length} hunk{selected.hunks.length === 1 ? "" : "s"}</span>
                        </div>
                      </>
                    ) : (
                      <div className="flex-1 flex items-center justify-center t-dim2 text-[12px]">
                        {changes ? "Select a file to view its diff" : "Loading changes…"}
                      </div>
                    )}
                  </div>
                </div>
      {peek && <PeekFile peek={peek} onClose={() => setPeek(null)} />}
    </div>
  );
}

/** The same viewer with a modal frame, for callers that drill into it rather
 *  than navigate to it (GitPanel's commit log, the file-card deep link). */
export function ChangesModal({ open, onClose, ...rest }: Omit<DiffViewProps, "active"> & { open: boolean; onClose: () => void }) {
  return (
    <Portal>
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
                <DiffView active={open} onClose={onClose} {...rest} />
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
