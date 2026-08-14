/**
 * The diff renderer: unified and side-by-side, over a list of hunks.
 *
 * It lives in its own file because three panels draw diffs — the working-tree
 * changes modal, the git panel and the pull-request review — and only two of
 * them own a `FileChange`. Anything that already parsed a unified diff into
 * hunks had to invent a `FileChange` around them just to get them painted, so
 * both components take `hunks` directly and treat `c` as the convenience case.
 *
 * Everything here is presentation. It never fetches, never decides which file
 * is selected, and never asks who is looking. The row builders are pure and
 * exported on purpose: a gutter that counts wrong is cheap to pin in a unit
 * test and nearly invisible in a 400-row diff, which is exactly how the
 * "\ No newline at end of file" off-by-one survived as long as it did.
 */
import { createContext, Fragment, memo, useContext, useMemo, useRef } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, WheelEvent as ReactWheelEvent } from "react";
import { HiliteCtx } from "../../lib/diffHighlight.ts";
import type { DiffHunk, FileChange } from "../../../../shared/types.ts";

// --- shared type + style vocabulary ------------------------------------------

/** Which file a line belongs to. Named after GitHub's review API because that
 *  is where a pick ends up when the diff is a pull request. */
export type DiffSide = "LEFT" | "RIGHT";
/** Where a comment lands: a line, on a side of the diff, optionally a range. */
export type LinePick = { line: number; side: DiffSide; shift: boolean; mode?: "comment" | "suggest" };
export type LineSel = { start: number; end: number; side: DiffSide } | null;

/** Line-level review actions, when the diff is a pull request. Present ⇒ the "+"
 *  gutter button opens a menu (comment / suggest / copy link); absent ⇒ it just
 *  fires onPick, which is all the working-tree changes modal needs. */
export const LineMenuCtx = createContext<{ permalink?: (line: number, side: DiffSide) => string | null } | null>(null);

/** Typical diff/coding font stack (honors an app --font-mono override if set). */
export const DIFF_FONT = 'var(--font-mono, "SF Mono"), SFMono-Regular, ui-monospace, "Cascadia Code", "Menlo", "Monaco", "Consolas", "Liberation Mono", "JetBrainsMono Nerd Font Mono", monospace';
/** Diff font + programming ligatures (== -> => etc.) — JetBrains Mono & friends. */
export const CODE_FONT_STYLE = { fontFamily: DIFF_FONT, fontFeatureSettings: '"calt" 1, "liga" 1' } as const;

/** Confine text selection to the side the drag started on (split view) so
 *  selecting the left column doesn't also grab the right. `data-sel` is set
 *  imperatively on mousedown, before the browser extends the selection. */
export const SPLIT_SEL_CSS = '.agx-split[data-sel="l"] [data-side="r"]{user-select:none;-webkit-user-select:none}.agx-split[data-sel="r"] [data-side="l"]{user-select:none;-webkit-user-select:none}';

/** The gutter "+" only appears on the line you are pointing at, so the diff
 *  reads as a diff until you want to say something about it.
 *
 *  20x20 rather than the 19 it used to be: it is an icon-only control, and the
 *  house floor for a hit area is 20x20 — an odd box also cannot sit on the 2px
 *  grid, which is how it ended up nudged by a stray -13px. */
export const LINEBTN_CSS = '.agx-gutter{position:relative}.agx-linebtn{position:absolute;right:-14px;top:50%;transform:translateY(-50%);width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:var(--primary);color:#fff;font-size:16px;font-weight:600;line-height:1;opacity:0;transition:opacity .12s,transform .12s;cursor:pointer;z-index:3;box-shadow:0 1px 3px rgba(0,0,0,.35)}.agx-gutter:hover .agx-linebtn,.agx-linebtn:focus-visible,.agx-linebtn[data-open="1"]{opacity:1}.agx-linebtn:hover{transform:translateY(-50%) scale(1.08)}';

/** Themed, slim scrollbars for the diff's scrollers (primary-tinted thumb). */
export const SCROLLBAR_CSS = '.agx-scroll{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--primary) 45%,transparent) transparent}.agx-scroll::-webkit-scrollbar{width:11px;height:11px}.agx-scroll::-webkit-scrollbar-track{background:transparent}.agx-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--primary) 38%,transparent);border-radius:999px;border:3px solid transparent;background-clip:padding-box}.agx-scroll::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--primary) 62%,transparent);background-clip:padding-box}.agx-scroll::-webkit-scrollbar-corner{background:transparent}';

// --- the row model (pure; everything below the components depends on it) -----

export type DiffKind = "ctx" | "del" | "add";
/** A run of a line's text, `hi` when the intra-line diff says it changed. */
export type Seg = { text: string; hi: boolean };
/** One unified row: at most one of the two gutters carries a number. */
export type URow = { oldN: number | null; newN: number | null; text: string; kind: DiffKind; segs?: Seg[] | null };
/** One side of one split row. Absent (`null` in `SplitRow`) means the other
 *  side has a line here and this one does not — painted as hatching. */
export type Cell = { num: number; text: string; kind: DiffKind; segs?: Seg[] | null };
export type SplitRow = { l: Cell | null; r: Cell | null };

/**
 * One raw hunk line → what to paint with, or null for the lines that are not
 * lines. Both builders go through here so they cannot disagree about a line.
 *
 * Dropped: "\ No newline at end of file". It is metadata about the file, not a
 * line in it — every other parser in the app drops it (prBody.parseUnifiedDiff,
 * server gitwork.parseDiff) — and a builder keying off `line[0]` alone sees
 * something that is neither + nor -, calls it context, paints a phantom row
 * reading " No newline at end of file" AND advances both gutters, putting every
 * number below it off by one.
 *
 * Dropped: a single trailing CR. A CRLF file arrives here as `" foo\r"`. The
 * prefix is still at index 0 so the +/- reading is unharmed, but the CR rides
 * into the row text, where `white-space: pre` treats it as a segment break —
 * a blank half-row under every line of the file — and it follows the code into
 * the clipboard on copy. It is a line terminator; the renderer draws lines.
 */
function parseLine(line: string): { kind: DiffKind; text: string } | null {
  if (line.startsWith("\\")) return null;
  const tag = line[0];
  const body = line.slice(1);
  return {
    kind: tag === "+" ? "add" : tag === "-" ? "del" : "ctx",
    text: body.endsWith("\r") ? body.slice(0, -1) : body,
  };
}

// --- intra-line (token-level) diff --------------------------------------------

// Whitespace runs, identifier runs, and every other character on its own: the
// three alternatives cover any string, so the tokens of a line always
// reconstruct it exactly. Callers rely on that — a segment list that lost a
// character would render code the file does not contain.
const WORD_RE = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;
const tokenize = (s: string): string[] => s.match(WORD_RE) ?? [];

/**
 * Token LCS between two lines → highlighted segments per side, or null when the
 * lines are too dissimilar to be "the same line, modified".
 *
 * The null cases are the point. Removals and additions are paired by position,
 * which is a guess, so two unrelated lines regularly land opposite each other;
 * without the similarity floor the guess gets painted as a word-level change
 * and the reader is told to look at noise. The size caps exist because the DP
 * table is O(n·m) and a minified bundle in a diff is one line of 200k.
 */
export function tokenDiff(a: string, b: string): { left: Seg[]; right: Seg[] } | null {
  if (!a || !b || a === b || a.length + b.length > 4000) return null;
  const ta = tokenize(a), tb = tokenize(b);
  const n = ta.length, m = tb.length;
  if (n + m > 600) return null;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const left: Seg[] = [], right: Seg[] = [];
  // Adjacent runs of the same verdict are merged as they are pushed, so the
  // renderer emits one <span> per visible change instead of one per token.
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

/** In a unified row list, pair each removal with the addition at the same offset
 *  in the following add block, and attach token segments to those pairs. Blocks
 *  are matched in order and never across a context line, because a context line
 *  is git telling us the change block ended. */
export function attachTokenDiff(rows: URow[]): void {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "del") { i++; continue; }
    let d = i; while (d < rows.length && rows[d].kind === "del") d++;
    let a = d; while (a < rows.length && rows[a].kind === "add") a++;
    for (let k = 0; k < Math.min(d - i, a - d); k++) {
      const td = tokenDiff(rows[i + k].text, rows[d + k].text);
      if (td) { rows[i + k].segs = td.left; rows[d + k].segs = td.right; }
    }
    i = a;
  }
}

// --- rows --------------------------------------------------------------------

/**
 * A hunk → unified rows, each carrying the two gutter numbers it deserves.
 *
 * Numbering restarts from this hunk's own `oldStart`/`newStart` every call, and
 * the components call it once per hunk: hunks are islands with a gap between
 * them, so carrying a running counter across them would number the second hunk
 * as though the skipped lines did not exist.
 */
export function unifiedRows(h: DiffHunk): URow[] {
  const rows: URow[] = [];
  let oldN = h.oldStart, newN = h.newStart;
  for (const line of h.lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.kind === "add") rows.push({ oldN: null, newN: newN++, text: p.text, kind: p.kind });
    else if (p.kind === "del") rows.push({ oldN: oldN++, newN: null, text: p.text, kind: p.kind });
    else rows.push({ oldN: oldN++, newN: newN++, text: p.text, kind: p.kind });
  }
  attachTokenDiff(rows);
  return rows;
}

/**
 * A hunk → paired old|new rows: removals sit left, additions right, and a
 * change block zips its −/+ lines together row by row.
 *
 * The zip runs to the LONGER of the two sides. Pairing to the shorter one is
 * the tempting version and it silently eats lines: three removals replaced by
 * one addition would render as one row and the reader would never learn the
 * other two were deleted.
 */
export function splitRows(h: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let oldN = h.oldStart, newN = h.newStart;
  let dels: Cell[] = [], adds: Cell[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const l = dels[i] ?? null, r = adds[i] ?? null;
      if (l && r) { const td = tokenDiff(l.text, r.text); if (td) { l.segs = td.left; r.segs = td.right; } }
      rows.push({ l, r });
    }
    dels = []; adds = [];
  };
  for (const line of h.lines) {
    // A dropped marker must not flush: git writes it between the − and the + of
    // a one-line no-newline change, and flushing there would split that pair
    // across two rows instead of showing them opposite each other.
    const p = parseLine(line);
    if (!p) continue;
    if (p.kind === "del") dels.push({ num: oldN++, text: p.text, kind: "del" });
    else if (p.kind === "add") adds.push({ num: newN++, text: p.text, kind: "add" });
    else { flush(); rows.push({ l: { num: oldN++, text: p.text, kind: "ctx" }, r: { num: newN++, text: p.text, kind: "ctx" } }); }
  }
  flush();
  return rows;
}

// --- painting ----------------------------------------------------------------

const HATCH = "repeating-linear-gradient(45deg, transparent, transparent 5px, color-mix(in srgb, var(--border) 10%, transparent) 5px, color-mix(in srgb, var(--border) 10%, transparent) 6px)";
const cellBg = (k?: DiffKind) => (k === "del" ? "color-mix(in srgb, var(--error) 13%, transparent)" : k === "add" ? "color-mix(in srgb, var(--success) 13%, transparent)" : "transparent");
const cellFg = (k?: DiffKind) => (k === "del" ? "var(--error)" : k === "add" ? "var(--success)" : "var(--text3)");
// Opaque variant of the row tint — for the sticky line-number gutter, so
// scrolling code passes behind it instead of showing through.
const numBg = (k?: DiffKind) => (k === "del" ? "color-mix(in srgb, var(--error) 13%, var(--bg))" : k === "add" ? "color-mix(in srgb, var(--success) 13%, var(--bg))" : "var(--bg)");
const SEL_BG = "color-mix(in srgb, var(--primary) 20%, transparent)";

function Marked({ segs, kind }: { segs: Seg[]; kind: "del" | "add" }) {
  const bg = kind === "del" ? "color-mix(in srgb, var(--error) 22%, transparent)" : "color-mix(in srgb, var(--success) 22%, transparent)";
  return <>{segs.map((s, i) => (s.hi ? <span key={i} style={{ background: bg, borderRadius: "2px" }}>{s.text}</span> : <span key={i}>{s.text}</span>))}</>;
}

/** Segment list → character ranges, so the token diff can be re-applied on top
 *  of Shiki's tokens, which cut the line at completely different offsets. */
function changedRanges(segs?: Seg[] | null): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!segs) return out;
  let off = 0;
  for (const s of segs) { if (s.hi) out.push([off, off + s.text.length]); off += s.text.length; }
  return out;
}

/** A diff line's text with Shiki token colors (foreground) and the token-level
 *  diff painted as a stronger background over the changed spans. Falls back to
 *  plain text / <Marked> until the highlighter + language load (or unknown lang). */
const Code = memo(function Code({ text, segs, kind }: { text: string; segs?: Seg[] | null; kind: DiffKind }) {
  const { hl, lang, theme } = useContext(HiliteCtx);
  const tokens = useMemo(() => {
    if (!hl || !lang || !theme || !text) return null;
    // `lang` is resolved from the file extension at runtime, so it can never be
    // one of Shiki's literal union members at compile time; a bad name throws
    // and we fall through to plain text.
    try { return hl.codeToTokens(text, { lang: lang as never, theme }).tokens[0] ?? []; } catch { return null; }
  }, [hl, lang, theme, text]);
  if (!tokens) return segs ? <Marked segs={segs} kind={kind === "del" ? "del" : "add"} /> : <>{text || " "}</>;
  const ranges = changedRanges(segs);
  const hiBg = kind === "del" ? "color-mix(in srgb, var(--error) 23%, transparent)" : "color-mix(in srgb, var(--success) 23%, transparent)";
  const out: ReactNode[] = [];
  let off = 0, key = 0;
  for (const tok of tokens) {
    const start = off, end = off + tok.content.length;
    // Shiki's fontStyle bitmask: 1=italic, 2=bold, 4=underline.
    const fs = tok.fontStyle ?? 0;
    const face: CSSProperties = { color: tok.color };
    if (fs & 2) face.fontWeight = 700;
    if (fs & 1) face.fontStyle = "italic";
    if (fs & 4) face.textDecoration = "underline";
    // Split this token wherever a changed range starts or ends inside it, so a
    // change that covers half an identifier tints half an identifier.
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

// --- line picking ------------------------------------------------------------

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

// --- what to draw ------------------------------------------------------------

/** Stable identity so a component given neither `hunks` nor `c` does not
 *  rebuild its rows on every render against a fresh empty array. */
const NO_HUNKS: DiffHunk[] = [];

type DiffProps = {
  /** Wins over `c.hunks`, for callers that parsed a diff and never had a file
   *  record to hang it on (a commit view, a review comment's context). */
  hunks?: DiffHunk[];
  c?: FileChange;
  wrap: boolean;
  rowAfter?: (newN: number | null | undefined, oldN: number | null | undefined) => ReactNode;
  onPick?: (p: LinePick) => void;
  sel?: LineSel;
};

// --- unified diff, with old|new gutters, uncapped -----------------------------

export function UnifiedDiff({ c, hunks, wrap, hunkAction, rowAfter, onPick, sel }: DiffProps & { hunkAction?: (hunkIndex: number) => ReactNode }) {
  const wrapCls = wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre";
  const source = hunks ?? c?.hunks ?? NO_HUNKS;
  const built = useMemo(() => source.map((h) => ({ h, rows: unifiedRows(h) })), [source]);
  return (
    <div className="agx-scroll flex-1 min-w-0 overflow-auto text-[12px] leading-[1.6]" data-vscroll style={CODE_FONT_STYLE}>
      {/*
       * One width for the whole file, and it is the widest line in it.
       *
       * Every hunk used to size itself, so scrolling right ran off the end of
       * the short ones: their rows stopped where their own longest line did and
       * the tint, the hunk bar and the row you were reading all gave way to bare
       * background, while a hunk further down still had text out there. Nothing
       * was missing — the paint simply ended at a different x per hunk.
       *
       * `max-content` here is the widest line in the FILE (the widest child),
       * and `min-width:100%` keeps a short file filling the pane. The children
       * are plain blocks, so they take this width rather than each measuring
       * their own.
       */}
      <div style={{ width: "max-content", minWidth: "100%" }}>
      {built.map(({ h, rows }, hi) => (
        <div key={hi}>
          <div data-hunk className="z-10 py-0.5 t-dim2" style={{ position: "var(--agx-hunk-pos, sticky)" as CSSProperties["position"], top: "var(--agx-hunk-top, 0px)", background: "color-mix(in srgb, var(--info) 12%, var(--bg))" }}>
            <span className="sticky left-0 inline-flex items-center gap-3 px-3">
              <span className="whitespace-pre">@@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</span>
              {hunkAction && hunkAction(hi)}
            </span>
          </div>
          {/* `minmax(max-content,1fr)`, not `max-content`: the column has to be
              at least as wide as the longest line in this hunk AND absorb
              whatever the file's width leaves over, or the row's background
              stops at the end of its own text. */}
          <div className="grid" style={{ gridTemplateColumns: wrap ? "4ch 4ch minmax(0,1fr)" : "4ch 4ch minmax(max-content,1fr)" }}>
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
                    className={`${wrapCls} px-1.5`} style={{ background: inSel(sel ?? null, r.newN, "RIGHT") || inSel(sel ?? null, r.oldN, "LEFT") ? SEL_BG : cellBg(r.kind), color: cellFg(r.kind) }}>
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
    </div>
  );
}

// --- side-by-side (split) diff, codiff-style, uncapped -----------------------

/**
 * Split view: two side-by-side columns, each its OWN horizontal scroller (so a
 * long line on one side scrolls independently, with its scrollbar pinned to the
 * bottom of the pane). Vertical scroll is kept in sync between the two so rows
 * stay aligned; only the right side shows the vertical scrollbar.
 */
export function SplitDiff({ c, hunks, wrap, rowAfter, onPick, sel }: DiffProps) {
  const source = hunks ?? c?.hunks ?? NO_HUNKS;
  const built = useMemo(() => source.map((h) => ({ h, rows: splitRows(h) })), [source]);
  const wrapCls = wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre";
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const onDown = (e: ReactMouseEvent) => {
    const el = (e.target as HTMLElement).closest("[data-side]") as HTMLElement | null;
    if (el?.dataset.side) (e.currentTarget as HTMLElement).setAttribute("data-sel", el.dataset.side);
  };
  const syncTop = () => {
    // Guarded by a flag cleared on the next frame: assigning scrollTop fires the
    // other pane's onScroll, and two panes echoing each other stutter the wheel.
    const src = rightRef.current, dst = leftRef.current;
    if (!src || !dst || syncing.current) return;
    syncing.current = true;
    dst.scrollTop = src.scrollTop;
    requestAnimationFrame(() => { syncing.current = false; });
  };
  const onLeftWheel = (e: ReactWheelEvent) => {
    // left has no vertical scrollbar — forward vertical wheel to the right side
    if (rightRef.current && e.deltaY) { rightRef.current.scrollTop += e.deltaY; e.preventDefault(); }
  };
  const side = (which: "l" | "r") => (
    /* Same rule as the unified pane: one width for the column, taken from the
       widest line in it, so a short hunk does not stop painting halfway across
       a scroll the file's longest line paid for. */
    <div style={{ width: "max-content", minWidth: "100%" }}>
    {built.map(({ h, rows }, hi) => (
      <div key={hi}>
        <div data-hunk className="z-10 py-0.5 t-dim2 whitespace-pre" style={{ position: "var(--agx-hunk-pos, sticky)" as CSSProperties["position"], top: "var(--agx-hunk-top, 0px)", background: "color-mix(in srgb, var(--info) 12%, var(--bg))" }}>
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
                className="flex" style={{ width: "max-content", minWidth: "100%", background: cell ? cellBg(cell.kind) : HATCH }}>
                <div data-side={which} className="text-right pr-1.5 tabular-nums select-none shrink-0 sticky left-0 z-[1] agx-gutter" style={{ width: "3.6ch", background: numBg(cell?.kind), boxShadow: "1px 0 0 0 color-mix(in srgb, var(--border) 22%, transparent)" }}>
                  <LineBtn n={cell?.num} side={which === "l" ? "LEFT" : "RIGHT"} onPick={onPick} />
                  <span className="opacity-40">{cell?.num ?? ""}</span>
                </div>
                <div className={`${wrapCls} px-1.5`} style={{ color: cellFg(cell?.kind), background: inSel(sel ?? null, cell?.num, which === "l" ? "LEFT" : "RIGHT") ? SEL_BG : undefined }}>{cell ? <Code text={cell.text} segs={cell.segs} kind={cell.kind} /> : ""}</div>
              </div>
              {after && (which === "l" ? <div aria-hidden style={{ visibility: "hidden" }}>{after}</div> : after)}
            </Fragment>
          );
        })}
      </div>
    ))}
    </div>
  );

  // WRAP: one aligned grid, no horizontal scroll — lines wrap in place and both
  // sides keep matching row heights (grid rows take the taller of the two).
  if (wrap) {
    return (
      <div className="agx-split agx-scroll flex-1 min-w-0 overflow-auto text-[12px] leading-[1.6]" data-vscroll style={CODE_FONT_STYLE} onMouseDown={onDown}>
        <style>{SPLIT_SEL_CSS}</style>
        {built.map(({ h, rows }, hi) => (
          <div key={hi}>
            <div data-hunk className="z-10 px-3 py-0.5 t-dim2 whitespace-pre" style={{ position: "var(--agx-hunk-pos, sticky)" as CSSProperties["position"], top: "var(--agx-hunk-top, 0px)", background: "color-mix(in srgb, var(--info) 12%, var(--bg))" }}>
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
