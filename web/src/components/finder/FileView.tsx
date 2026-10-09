/*
 * The finder's centre: whatever file is selected, read where it is.
 *
 * This is the half that used to be somewhere else. A result opened by handing it
 * to the document viewer (prose) or to a bench tab (everything else), so looking
 * at a `.py` in a search cost you the search — the finder was left behind under a
 * tmux window. Now every kind of file has a face here and the bench is a button:
 *
 *   markdown  the reader: rendered, at a chosen size and measure, with find
 *   code      line numbers and syntax colour (the diff's highlighter, so the two
 *             agree about what a keyword is); html shows its source
 *   picture   drawn on a checkerboard so transparency is legible
 *   pdf, video, audio  the browser's own players
 *
 * "Editing" is the bench: the toggle keeps the reader's vocabulary because that
 * is where the muscle memory is, but it does not turn this pane into an editor —
 * an editor here would be a second one to keep honest.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../../lib/markdown.tsx";
import { useDiffHighlight } from "../../lib/diffHighlight.ts";
import { CODE_FONT_STYLE } from "../diff/DiffLines.tsx";
import { EDGE, LINE } from "../workspace/Chrome.tsx";
import { FindBar } from "../PeekFile.tsx";
import { SearchIcon, IconLabel, MoreIcon, CaretIcon, DoneIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import {
  mdSize, setMdSize, mdWidth, setMdWidth, codeSize, setCodeSize, codeWidth, setCodeWidth, widthLabel,
  SIZE_MIN, SIZE_MAX, WIDTHS, type MdWidth,
} from "../../lib/mdPrefs.ts";
import { findRanges, paint as paintFind, clear as clearFind, step as stepFind, reveal as revealFind } from "../../lib/mdFind.ts";
import type { LoadedFile } from "./useFileSource.ts";

/** Past this many lines the colour is skipped: tokenising a 30,000-line file
 *  blocks the frame the selection changed in, and a file that long is being
 *  searched, not admired. It is still shown, with its numbers. */
const HIGHLIGHT_MAX_LINES = 6000;

export type Jump = { kind: "line"; line: number; n: number } | { kind: "heading"; label: string; nth: number; n: number };

const segStyle = (on: boolean) => on
  ? { background: "color-mix(in srgb, var(--primary) 22%, transparent)", color: "var(--text)" }
  : { color: "var(--text3)" };

export function FileView({ file, branch, jump, initialTop, onTop, onBench, onOpenBrowser, canBrowser, findSignal }: {
  file: LoadedFile;
  branch?: string;
  jump: Jump | null;
  /** Where to put the scroll when this file appears — see finderState.scrollFor. */
  initialTop: number;
  onTop: (top: number) => void;
  onBench: () => void;
  onOpenBrowser?: () => void;
  canBrowser: boolean;
  /** Bumped by the parent to open the find bar (the chord lives up there). */
  findSignal: number;
}) {
  const { kind, text } = file;
  const isText = kind === "markdown" || kind === "code" || kind === "html";
  const prose = kind === "markdown";
  const [proseSize, setProseSize] = useState(() => mdSize());
  const [proseWidth, setProseWidth] = useState<MdWidth>(() => mdWidth());
  const [srcSize, setSrcSize] = useState(() => codeSize());
  const [srcWidth, setSrcWidth] = useState<MdWidth>(() => codeWidth());
  const size = prose ? proseSize : srcSize;
  const width = prose ? proseWidth : srcWidth;
  const setSize = (f: (n: number) => number) => (prose ? setProseSize((n) => setMdSize(f(n))) : setSrcSize((n) => setCodeSize(f(n))));
  const setWidth = (w: MdWidth) => (prose ? setProseWidth(setMdWidth(w)) : setSrcWidth(setCodeWidth(w)));
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [menu, setMenu] = useState(false);
  const [line, setLine] = useState<number | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);

  /* ------------------------------------------------------------- colour */
  const { hilite } = useDiffHighlight(isText && !prose ? file.name : undefined);
  const lines = useMemo(() => (text === null || prose ? [] : text.replace(/\n$/, "").split("\n")), [text, prose]);
  const tokens = useMemo(() => {
    if (!hilite.hl || !hilite.lang || !hilite.theme || text === null || prose || lines.length > HIGHLIGHT_MAX_LINES) return null;
    try { return hilite.hl.codeToTokens(text.replace(/\n$/, ""), { lang: hilite.lang as never, theme: hilite.theme }).tokens; } catch { return null; }
  }, [hilite, text, prose, lines.length]);

  /* ------------------------------------------------------------- scroll */
  const key = file.source ? `${file.source.abs ?? file.source.rel}@${file.source.ref ?? ""}` : "";
  const placed = useRef("");
  useEffect(() => { setLine(null); setFindOpen(false); setNeedle(""); clearFind(); }, [key]);
  /* Put the scroll back once there is something to scroll. Once per file: a
     later refresh of the same text must not drag you back up. */
  useEffect(() => {
    const el = scroller.current;
    if (!el || placed.current === key) return;
    if (text === null && !file.media) return;
    placed.current = key;
    el.scrollTop = initialTop;
    // `initialTop` is read at the moment the file arrives, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, text, file.media]);
  const pending = useRef(0);
  const onScroll = () => {
    if (pending.current) return;
    pending.current = requestAnimationFrame(() => { pending.current = 0; onTop(scroller.current?.scrollTop ?? 0); });
  };
  useEffect(() => () => { if (pending.current) cancelAnimationFrame(pending.current); }, []);

  /* --------------------------------------------------------------- jumps */
  useEffect(() => {
    if (!jump || text === null) return;
    const el = scroller.current;
    const root = body.current;
    if (!el || !root) return;
    let target: HTMLElement | null = null;
    if (jump.kind === "line") {
      target = root.querySelector<HTMLElement>(`[data-line="${jump.line}"]`);
      setLine(jump.line);
    } else {
      const hs = [...root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")].filter((h) => (h.textContent ?? "").trim() === jump.label);
      target = hs[jump.nth] ?? hs[0] ?? null;
    }
    if (target) el.scrollTo({ top: target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16, behavior: "smooth" });
  }, [jump, text]);

  /* ---------------------------------------------------------------- find */
  const [findOpen, setFindOpen] = useState(false);
  const [needle, setNeedle] = useState("");
  const [hit, setHit] = useState(0);
  const [hits, setHits] = useState(0);
  const ranges = useRef<Range[]>([]);
  const findRef = useRef<HTMLInputElement>(null);
  const openFind = useCallback(() => {
    setFindOpen(true);
    setTimeout(() => { findRef.current?.focus(); findRef.current?.select(); }, 0);
  }, []);
  useEffect(() => { if (findSignal && isText) openFind(); }, [findSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isText || !findOpen || !needle.trim()) { ranges.current = []; setHits(0); clearFind(); return; }
    const found = findRanges(body.current, needle);
    ranges.current = found; setHits(found.length); setHit((i) => (i < found.length ? i : 0));
  }, [needle, text, findOpen, isText, size, width, tokens]);
  useEffect(() => { if (findOpen) paintFind(ranges.current, hit); }, [hit, hits, findOpen]);
  useEffect(() => () => clearFind(), []);
  const goHit = useCallback((dir: 1 | -1) => {
    const n = ranges.current.length;
    if (!n) return;
    setHit((i) => { const next = stepFind(i, n, dir); revealFind(ranges.current[next]); return next; });
  }, []);

  const copy = () => {
    if (text === null) return;
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => { /* no permission */ });
  };

  /* -------------------------------------------------------------- header */
  const segs = (file.source?.abs ?? file.source?.rel ?? "").split("/").filter(Boolean);
  const crumb = segs.slice(-3);
  const disabled = text === null;

  const toolbar = (
    <div className="flex items-center gap-2 px-4 shrink-0 text-[11px]" style={{ minHeight: 42, borderBottom: LINE, color: "var(--text3)" }}>
      <span className="min-w-0 truncate" title={file.source?.abs ?? file.source?.rel}>
        {crumb.map((s, i) => (
          <span key={i}>
            {i > 0 && <span style={{ color: "var(--text4)" }}> / </span>}
            <span style={i === crumb.length - 1 ? { color: "var(--text)", fontWeight: 600 } : undefined}>{s}</span>
          </span>
        ))}
        {branch && <span style={{ color: "var(--text4)" }}> · {branch}</span>}
      </span>
      {isText && (
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <span className="flex items-center rounded-md overflow-hidden" style={{ border: EDGE }} role="group" aria-label="Face">
            <button className="agx-btn px-2.5 py-1 text-[10.5px]" style={segStyle(true)} aria-pressed title="Read it here">Reading</button>
            <button className="agx-btn px-2.5 py-1 text-[10.5px]" style={segStyle(false)} onClick={onBench}
              title="Edit it on the bench — the finder does not edit">Editing</button>
          </span>
          <span className="flex items-center gap-1">
            <span className="text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>Text</span>
            <span className="flex items-center rounded-md overflow-hidden" style={{ border: EDGE }}>
              <button onClick={() => setSize((n) => n - 1)} disabled={size <= SIZE_MIN} title="Smaller" className="agx-btn px-1.5 py-1 text-[10.5px] disabled:opacity-30" style={{ color: "var(--text2)" }}>A−</button>
              <span className="px-1 text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{size}</span>
              <button onClick={() => setSize((n) => n + 1)} disabled={size >= SIZE_MAX} title="Bigger" className="agx-btn px-1.5 py-1 text-[10.5px] disabled:opacity-30" style={{ color: "var(--text2)" }}>A+</button>
            </span>
          </span>
          <span className="flex items-center gap-1">
            <span className="text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>Width</span>
            <span className="flex items-center rounded-md overflow-hidden" style={{ border: EDGE }}>
              {WIDTHS.map((w) => (
                <button key={w} onClick={() => setWidth(w)} className="agx-btn px-1.5 py-1 text-[10.5px]" style={segStyle(w === width)}
                  title={w === 0 ? "Use the whole pane" : `${w} characters a line`}>{widthLabel(w)}</button>
              ))}
            </span>
          </span>
          <button onClick={openFind} disabled={disabled} title="Find in this file (Ctrl+F or /)" className="agx-btn rounded-md px-2 py-1 text-[10.5px]"
            style={{ color: findOpen ? "var(--primary-hover)" : "var(--text2)", border: EDGE, opacity: disabled ? 0.4 : 1 }}>
            <IconLabel icon={<SearchIcon size={ICON.xs} />}>Find <span style={{ color: "var(--text4)" }}>/</span></IconLabel>
          </button>
          <span className="relative">
            <button onClick={() => setMenu((m) => !m)} aria-expanded={menu} className="agx-btn rounded-md px-2 py-1 text-[10.5px]" style={{ color: "var(--text2)", border: EDGE }}>
              <IconLabel icon={<MoreIcon size={ICON.sm} />}>More <CaretIcon size={ICON.xs} /></IconLabel>
            </button>
            {menu && (
              <div className="absolute right-0 mt-1 rounded-lg py-1 z-10 text-[11px]" role="menu"
                style={{ minWidth: 190, background: "var(--surface-card)", border: EDGE, boxShadow: "0 12px 30px -10px var(--shadow)" }}
                onMouseLeave={() => setMenu(false)}>
                <button role="menuitem" className="agx-btn w-full text-left px-3 py-1.5" disabled={disabled} onClick={() => { copy(); setMenu(false); }}
                  style={{ color: copied ? "var(--success-ink)" : "var(--text2)" }}>
                  <IconLabel icon={copied ? <DoneIcon size={ICON.sm} /> : undefined}>{copied ? "Copied" : "Copy contents"}</IconLabel>
                </button>
                {!prose && (
                  <button role="menuitem" className="agx-btn w-full text-left px-3 py-1.5" aria-pressed={wrap} onClick={() => { setWrap((w) => !w); setMenu(false); }}
                    style={{ color: "var(--text2)" }}>{wrap ? "Do not wrap long lines" : "Wrap long lines"}</button>
                )}
                {kind === "html" && canBrowser && onOpenBrowser && (
                  <button role="menuitem" className="agx-btn w-full text-left px-3 py-1.5" onClick={() => { onOpenBrowser(); setMenu(false); }}
                    style={{ color: "var(--text2)" }}>Open in browser</button>
                )}
              </div>
            )}
          </span>
        </span>
      )}
      {kind === "html" && canBrowser && onOpenBrowser && (
        <button onClick={onOpenBrowser} className="agx-btn rounded-md px-2.5 py-1 text-[10.5px]"
          style={{ color: "var(--primary-ink)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" }}>Open in browser</button>
      )}
    </div>
  );

  /* ---------------------------------------------------------------- body */
  let content: React.ReactNode;
  if (!file.source) {
    content = <Centered>Nothing selected</Centered>;
  } else if (file.error) {
    content = <Centered tint="var(--warning-ink)">{file.error}</Centered>;
  } else if (file.loading) {
    content = <div className="flex-1 grid place-items-center"><span className="agx-spin" aria-hidden="true" /></div>;
  } else if (kind === "markdown" && text !== null) {
    content = (
      <div ref={body} className="agx-prose mx-auto px-8 py-8" style={{ maxWidth: width ? `${width}ch` : "none", fontSize: size }}>
        <Markdown text={text} />
        {file.truncated && <Truncated />}
      </div>
    );
  } else if ((kind === "code" || kind === "html") && text !== null) {
    const digits = String(lines.length).length;
    content = (
      <div ref={body} className="py-3 min-w-0" style={{ ...CODE_FONT_STYLE, fontSize: size, lineHeight: 1.65, maxWidth: width ? `calc(${width}ch + ${digits + 4}ch)` : "none" }}>
        {lines.map((ln, i) => (
          <div key={i} data-line={i + 1} className="flex"
            style={line === i + 1 ? { background: "color-mix(in srgb, var(--primary) 14%, transparent)" } : undefined}>
            <span aria-hidden className="shrink-0 text-right select-none tabular-nums px-3 cursor-pointer"
              onClick={() => setLine(line === i + 1 ? null : i + 1)}
              style={{ width: `${digits + 3}ch`, color: line === i + 1 ? "var(--text2)" : "var(--text4)", boxSizing: "content-box", borderRight: LINE, marginRight: 14 }}>{i + 1}</span>
            <span className="min-w-0 flex-1" style={{ whiteSpace: wrap ? "pre-wrap" : "pre", overflowWrap: wrap ? "anywhere" : undefined, color: "var(--text)" }}>
              {tokens?.[i]?.length
                ? tokens[i]!.map((t, k) => <span key={k} style={{ color: t.color, fontStyle: t.fontStyle && t.fontStyle & 1 ? "italic" : undefined, fontWeight: t.fontStyle && t.fontStyle & 2 ? 700 : undefined }}>{t.content}</span>)
                : ln || "​"}
            </span>
          </div>
        ))}
        {file.truncated && <Truncated />}
      </div>
    );
  } else if (kind === "image") {
    content = file.media ? (
      <div className="grid place-items-center p-6 min-h-full">
        <img src={file.media.url} alt={file.name}
          style={{ maxWidth: "100%", maxHeight: "72vh", objectFit: "contain", borderRadius: 6,
            background: "repeating-conic-gradient(color-mix(in srgb, var(--text) 6%, transparent) 0% 25%, transparent 0% 50%) 50% / 16px 16px" }} />
      </div>
    ) : file.mediaError ? <Centered tint="var(--warning-ink)">{file.mediaError}</Centered>
      : file.facts?.kind === "image-convert" && !file.facts.converter
        ? <Centered>This format needs converting and this machine has no tool for it (magick, convert, heif-convert or ffmpeg).</Centered>
        : <div className="p-10 grid place-items-center"><span className="agx-spin" aria-hidden="true" /></div>;
  } else if (kind === "pdf") {
    content = file.media ? <embed src={file.media.url} type="application/pdf" style={{ width: "100%", height: "100%", minHeight: 520 }} /> : <div className="p-10 grid place-items-center"><span className="agx-spin" aria-hidden="true" /></div>;
  } else if (kind === "video") {
    content = file.media ? <div className="grid place-items-center p-4"><video src={file.media.url} controls style={{ maxWidth: "100%", maxHeight: "72vh" }} /></div> : <div className="p-10 grid place-items-center"><span className="agx-spin" aria-hidden="true" /></div>;
  } else if (kind === "audio") {
    content = file.media ? <div className="p-6"><audio src={file.media.url} controls style={{ width: "100%" }} /></div> : <div className="p-10 grid place-items-center"><span className="agx-spin" aria-hidden="true" /></div>;
  } else if (kind === "dir") {
    content = <Centered>A folder — <span style={{ color: "var(--text2)" }}>⏎</span> to go in</Centered>;
  } else {
    content = <Centered>No preview for this kind of file. The facts on the right still say which one it is.</Centered>;
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col" style={{ background: "var(--bg)" }}>
      {toolbar}
      {findOpen && isText && (
        <FindBar inputRef={findRef} value={needle} onValue={(v) => { setNeedle(v); setHit(0); }}
          hit={hits ? hit + 1 : 0} hits={hits} onStep={goHit}
          onClose={() => { setFindOpen(false); setNeedle(""); clearFind(); }} />
      )}
      <div ref={scroller} onScroll={onScroll} className="flex-1 min-h-0 agx-scroll overflow-auto" tabIndex={0} data-finder-viewer
        style={{ outline: "none" }}>
        {content}
      </div>
    </div>
  );
}

const Centered = ({ children, tint }: { children: React.ReactNode; tint?: string }) => (
  <div className="h-full min-h-[200px] grid place-items-center text-[11.5px] px-8 text-center" style={{ color: tint ?? "var(--text3)" }}>{children}</div>
);

const Truncated = () => (
  <div className="mt-4 mx-3 text-[11.5px]" style={{ color: "var(--warning-ink)" }}>
    This file is longer than the finder reads and is shown up to there. To the bench for the rest.
  </div>
);
