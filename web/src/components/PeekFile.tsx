// A file, in an editor, without leaving the panel you were reading.
//
// The gap this closes: you are looking at a diff or a filtered list of changed
// files, you want to see one of them whole, and the only route was to find a
// terminal, get it into the right worktree, and type the path — by which point
// you have lost the list you were working from. It opens over the panel, on the
// file you clicked, and closes back to it.
//
// Its own PTY rather than a tab in the terminal view, on purpose: the terminal
// you have open is in whatever directory you left it in, and a pull request's
// file lives in a specific checkout. Borrowing that session would mean either
// moving it — losing your place — or opening the wrong file with a confident
// path.
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
// The stylesheet the renderer needs. It arrives via TerminalPanel today, but a
// component that cannot draw without it should say so itself.
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Portal } from "./Portal.tsx";
import { LAYER } from "../lib/layers.ts";
import { ptyWsUrl, IS_DEMO } from "../lib/api.ts";
import { showFile } from "../lib/benchStore.ts";
import { themeFromCss } from "./TerminalPanel.tsx";
import { answerDecrqm } from "../lib/xtermDecrqm.ts";
import { termOptions } from "../lib/termPrefs.ts";
import { CloseButton } from "./CloseButton.tsx";
import { Markdown } from "../lib/markdown.tsx";
import { api } from "../lib/api.ts";
import { canReveal, revealPath } from "../lib/desktop.ts";
import {
  mdSize, setMdSize, mdWidth, setMdWidth, widthLabel,
  SIZE_MIN, SIZE_MAX, WIDTHS, type MdWidth,
} from "../lib/mdPrefs.ts";
import { findRanges, paint as paintFind, clear as clearFind, step as stepFind, reveal as revealFind } from "../lib/mdFind.ts";
import { groupAt, groupLabel, groupTotals, type ChangeGroup } from "../lib/changeGroups.ts";

export type Peek = {
  root: string;
  path: string;
  label?: string;
  /**
   * Open it for editing rather than for reading.
   *
   * Off by default, and that default is the design. This opens from a diff and
   * from a pull request — places you go to look, often at a copy of a branch
   * you do not have — where an editor is one keystroke from changing a file
   * nobody meant to touch. The file tree is the other case: your checkout, your
   * branch, opened precisely to change something. So editing is a thing a
   * caller says, not a thing it gets.
   */
  edit?: boolean;
  /** The branch this checkout is on, shown in the title bar. Not decoration:
   *  with five worktrees of one repository, "which one am I editing" is the
   *  question a writable editor has to answer before you type. */
  branch?: string;
  /**
   * Read it as this ref has it, not as the disk has it.
   *
   * Set when the file was found on a branch you are not on — origin/master,
   * usually. It makes the pane read-only by construction rather than by
   * politeness: there is no file to edit, only an object in the store, and an
   * editor pointed at the working tree's path would open a DIFFERENT file
   * wearing the right name.
   */
  ref?: string;
  /** Land on this line rather than on the first one — the change you came for. */
  line?: number;
  /**
   * Where the file changed, for the rail down the right.
   *
   * A diff tells you a file has four changed places and then hands you a file
   * with no sign of where they are: "I don't know how to get to that line quickly
   * and I have no information to move around with". The rail is that information — see
   * changeGroups.ts for why it is places and not lines.
   */
  groups?: ChangeGroup[];
};

/** Files this app can render instead of edit. Only markdown, deliberately:
 *  everything else in a checkout is code, and code is better read in the editor
 *  that knows its language than in a viewer that would have to learn them all. */
const READABLE = /\.(md|markdown|mdx)$/i;

/** Exported so a caller can ask the question before deciding how to open a file
 *  — the palette has to know, because a file on another branch has to be written
 *  out for the editor and a document does not. One regexp, one answer: two
 *  places disagreeing about what "renderable" means is how a `.py` ended up in
 *  the markdown viewer. */
export const isRenderable = (path: string) => READABLE.test(path);

/**
 * Where the file changed, down its right, as places rather than as lines.
 *
 * The first version listed one entry per changed line: sixty-three numbers for
 * a file with four changes in it. "130, 131, 132 … 141" is one thing — a
 * function somebody added — and a list that says otherwise is a list nobody
 * reads. So a run of changes is one row carrying its range, how much it changed
 * and, where the language makes it findable, the name of what it is inside
 * (see changeGroups.ts). The name is what you are looking for; the number is
 * what confirms it.
 *
 * Three things make it a map rather than a menu:
 *
 *   * the strip on the left is the WHOLE file at scale, with a band per change
 *     and the part you are looking at boxed — so "all at the top" and "spread
 *     through it" are one glance apart;
 *   * it follows the cursor, so scrolling in the editor lights the place you
 *     landed in;
 *   * and a place unfolds into its own lines for the tenth time out of ten,
 *     when the range is forty lines and you want the third edit.
 */
function ChangeRail({ groups, fileLines, cursor, onGo }: {
  groups: ChangeGroup[];
  /** How long the file is, for the strip. 0 when nobody has counted it, and
   *  then the strip is not drawn rather than drawn to a made-up length. */
  fileLines: number;
  /** Where the editor's cursor is, when it can be asked. 0 for "no idea". */
  cursor: number;
  onGo: (line: number) => void;
}) {
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  /* The cursor decides, when there is one: the rail follows the editor rather
     than remembering the last press. Without one it is the last press, which is
     what it was before anything could ask nvim where it is. */
  const at = cursor > 0 ? groupAt(groups, cursor) : sel;
  useEffect(() => { if (cursor > 0) setSel(groupAt(groups, cursor)); }, [cursor, groups]);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[data-on="1"]')?.scrollIntoView({ block: "nearest" });
  }, [at]);

  if (!groups.length) return null;
  const totals = groupTotals(groups);
  const go = (i: number) => {
    const n = Math.min(Math.max(i, 0), groups.length - 1);
    setSel(n);
    onGo(groups[n]!.from);
  };
  const step = (d: 1 | -1) => go((at + d + groups.length) % groups.length);
  /** Where a line sits in the file, as a percentage — the strip's whole maths. */
  const pc = (line: number) => Math.max(0, Math.min(100, (line / Math.max(fileLines, 1)) * 100));
  const here = groups[at];

  return (
    <div className="shrink-0 flex flex-col"
      style={{ width: 190, borderLeft: "1px solid color-mix(in srgb, var(--text) 12%, transparent)", background: "color-mix(in srgb, var(--text) 3%, transparent)" }}>
      {/* Where the cursor is, in the file's own words. Blank until the editor
          answers, rather than a guess that would be wrong half the time. */}
      {here?.symbol && (
        <div className="px-2 pt-2 pb-1 text-[10px] leading-tight truncate" style={{ color: "var(--text2)" }} title={here.symbol}>
          {here.symbol}
        </div>
      )}
      <div className="flex items-center gap-1 px-2 pb-1.5 pt-1" style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 10%, transparent)" }}>
        <span className="text-[9.5px] tabular-nums" style={{ color: "var(--text4)" }}>
          {totals.places} {totals.places === 1 ? "place" : "places"}
        </span>
        <span className="ml-auto text-[9.5px] tabular-nums flex gap-1">
          {totals.added > 0 && <span style={{ color: "var(--success, #98c379)" }}>+{totals.added}</span>}
          {totals.removed > 0 && <span style={{ color: "var(--error)" }}>−{totals.removed}</span>}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex gap-1 px-1.5 py-1.5">
        {/* The file at scale. Ten pixels wide, and the only thing on this rail
            that answers "are the changes together or all over it". */}
        {fileLines > 0 && (
          <button className="relative shrink-0 rounded"
            title="The whole file — press to jump to that part of it"
            style={{ width: 10, background: "color-mix(in srgb, var(--text) 8%, transparent)" }}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const line = Math.round(((e.clientY - r.top) / Math.max(r.height, 1)) * fileLines);
              const near = groups.reduce((best, g, i) => (Math.abs(g.from - line) < Math.abs(groups[best]!.from - line) ? i : best), 0);
              go(near);
            }}>
            {groups.map((g, i) => (
              <span key={i} aria-hidden className="absolute left-0 right-0 rounded-sm"
                style={{
                  top: `${pc(g.from)}%`,
                  height: `${Math.max(1.2, pc(g.to) - pc(g.from))}%`,
                  background: g.added && !g.removed ? "var(--success, #98c379)"
                    : g.removed && !g.added ? "var(--error)" : "var(--warning)",
                  opacity: i === at ? 1 : 0.55,
                }} />
            ))}
            {/* Where the cursor is, boxed. */}
            {cursor > 0 && (
              <span aria-hidden className="absolute rounded-sm"
                style={{ top: `calc(${pc(cursor)}% - 1px)`, left: -2, right: -2, height: 3, background: "var(--primary)" }} />
            )}
          </button>
        )}

        <div ref={box} className="agx-scroll flex-1 min-w-0 overflow-y-auto flex flex-col gap-0.5">
          {groups.map((g, i) => (
            <div key={`${g.from}-${i}`} className="min-w-0">
              <button onClick={() => go(i)} data-on={i === at ? "1" : undefined}
                onDoubleClick={() => setOpen(open === i ? null : i)}
                title={`${groupLabel(g)}${g.symbol ? ` · ${g.symbol}` : ""} — double-click for the lines`}
                className="w-full rounded px-1.5 py-1 text-left"
                style={{
                  background: i === at ? "color-mix(in srgb, var(--primary) 20%, transparent)" : "transparent",
                  boxShadow: i === at ? "inset 2px 0 0 var(--primary)" : undefined,
                }}>
                <span className="flex items-baseline gap-1.5">
                  <span className="text-[10.5px] tabular-nums" style={{ color: i === at ? "var(--text)" : "var(--text2)" }}>{groupLabel(g)}</span>
                  <span className="ml-auto text-[9.5px] tabular-nums shrink-0">
                    {g.added > 0 && <span style={{ color: "var(--success, #98c379)" }}>+{g.added}</span>}
                    {g.removed > 0 && <span style={{ color: "var(--error)" }}> −{g.removed}</span>}
                  </span>
                </span>
                {g.symbol && (
                  <span className="block text-[9.5px] truncate" style={{ color: i === at ? "var(--text2)" : "var(--text4)" }}>{g.symbol}</span>
                )}
              </button>
              {open === i && g.lines.length > 1 && (
                <div className="flex flex-wrap gap-0.5 pl-2 pb-1">
                  {g.lines.map((n) => (
                    <button key={n} onClick={() => { setSel(i); onGo(n); }}
                      className="agx-btn rounded text-[9.5px] tabular-nums px-1"
                      style={{ color: "var(--text3)" }} title={`Line ${n}`}>{n}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between px-2 py-1" style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 10%, transparent)" }}>
        <span className="flex items-center gap-1">
          <button className="agx-btn rounded grid place-items-center" style={{ width: 20, height: 20, color: "var(--text3)" }}
            title="Previous place (p)" onClick={() => step(-1)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 14l6-6 6 6" /></svg>
          </button>
          <button className="agx-btn rounded grid place-items-center" style={{ width: 20, height: 20, color: "var(--text3)" }}
            title="Next place (n)" onClick={() => step(1)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 10l6 6 6-6" /></svg>
          </button>
        </span>
        <span className="text-[9.5px] tabular-nums" style={{ color: "var(--text4)" }}>{at + 1} / {groups.length}</span>
      </div>
    </div>
  );
}

export function PeekFile({ peek, onClose, topPx }: {
  peek: Peek;
  onClose: () => void;
  /**
   * Where the top edge goes, in pixels, when something above has to stay
   * visible.
   *
   * The file palette is that something: it stays open after it opens a
   * document so the next result is a keystroke rather than another search, and
   * it was landing on the document's first lines — covering precisely what you
   * opened it to read. The two share the screen instead of fighting for it.
   *
   * Left undefined everywhere else, where 6vh is right and nothing is above.
   */
  topPx?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  /** Send the editor to a line. Set once the socket is up — see the effect. */
  const jump = useRef<((line: number) => void) | null>(null);
  /** How long the file is, for the strip of the whole file. 0 until measured,
   *  and the strip is simply not drawn until then. */
  const [fileLines, setFileLines] = useState(0);
  /** Where the editor's cursor is. 0 for "nothing can be asked" — no nvim, an
   *  older one, a socket that died — and the rail then works the way it did
   *  before any of this existed. */
  const [cursor, setCursor] = useState(0);
  /** The handle for asking. Arrives in the pty's `ready` frame. */
  const [editorId, setEditorId] = useState("");
  const [error, setError] = useState<string | null>(null);
  /*
   * Read it, or edit it.
   *
   * A markdown document opened from the file tree is a thing you are almost
   * always going to READ — a status report, a risk register, a spec — and it
   * arrived in nvim, where the tables are pipes and the headings are hashes.
   * So this pane has two faces and one file, and the toggle stays visible in
   * both: the editor is one keystroke away when reading turns into changing.
   *
   * Reading is the default for markdown, and only for markdown. Anything else
   * has no rendered form worth showing and opens as it always did.
   */
  /*
   * Find inside the document.
   *
   * Ctrl+F, plain — and only in this face. The browser's own find searches the
   * whole page, which here means the terminal and the board BEHIND this panel,
   * walking you through matches in text you cannot see. In the editing face the
   * key belongs to the editor, which is why the terminal panel binds the
   * shifted form; there is no editor here to take it from.
   */
  const [findOpen, setFindOpen] = useState(false);
  const [needle, setNeedle] = useState("");
  const [hit, setHit] = useState(0);
  const [hits, setHits] = useState(0);
  const proseRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);

  useEffect(() => {
    setFileLines(0);
    if (!peek.groups?.length) return;
    let live = true;
    void api.filesMeasure(peek.path).then((r) => { if (live && r.ok && r.lines) setFileLines(r.lines); }).catch(() => { /* no strip, then */ });
    return () => { live = false; };
  }, [peek.path, peek.groups]);

  /* Where the cursor is, while this pane is open.
     Polled rather than pushed: nvim answers an expression over its socket and
     has no way to call us. Under half a second is what "it follows me" feels
     like; the call is one short-lived process and it stops with the pane. */
  useEffect(() => {
    if (!editorId) return;
    let live = true;
    const ask = () => {
      void api.editorWhere(editorId).then((r) => { if (live && r.ok && r.line) setCursor(r.line); }).catch(() => { /* no idea, then */ });
    };
    ask();
    const timer = setInterval(ask, 450);
    return () => { live = false; clearInterval(timer); };
  }, [editorId]);

  const canRender = READABLE.test(peek.path);
  /* A ref has no file on disk, so there is nothing for an editor to open. Held
     as its own name because it is the reason for several decisions below. */
  const atRef = !!peek.ref;
  /* The demo has no PTY, so there is no editor to switch to and reading is the
     only face there is. Without this, code opened in the demo took the editor
     face and drew nothing — a dead panel, which is the thing the demo's terminal
     and browser each had to be talked out of being. */
  const [reading, setReading] = useState(canRender || !!peek.ref || IS_DEMO);
  const [text, setText] = useState<string | null>(null);
  const [textErr, setTextErr] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  /* Reading settings of this pane alone — see mdPrefs.ts for why they are not
     the app's display size or the terminal's font. */
  const [size, setSize] = useState(() => mdSize());
  const [width, setWidth] = useState<MdWidth>(() => mdWidth());
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  const copy = () => {
    if (text === null) return;
    // The SOURCE, not the rendering. Somebody copying out of a document viewer
    // is taking it somewhere that speaks markdown — a card, a message, another
    // file — and a paste of styled text would arrive as a wall.
    navigator.clipboard?.writeText(text)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })
      .catch(() => { /* no clipboard permission — nothing to say about it */ });
  };

  const reveal = async () => {
    const r = await revealPath(peek.path);
    if (r && !r.ok) { setRevealed(r.error ?? "Could not open that folder"); setTimeout(() => setRevealed(null), 2600); }
  };

  useEffect(() => {
    if (!reading) return;
    let live = true;
    setText(null); setTextErr(null); setTruncated(false);
    api.filesRead(peek.root, peek.path, peek.ref)
      .then((r) => {
        if (!live) return;
        if (r.ok) { setText(r.text); setTruncated(!!r.truncated); }
        else setTextErr(r.error || "Could not read that file");
      })
      .catch((e) => { if (live) setTextErr(String(e)); });
    return () => { live = false; };
  }, [reading, peek.root, peek.path, peek.ref]);
  /*
   * `onClose` is a new function on every render of the parent, and it was in
   * this effect's dependencies — so the whole terminal was torn down and rebuilt
   * on any re-render, and the teardown's own `ws.close()` fired `onclose`, which
   * called `onClose`. The window opened, the parent re-rendered, and it shut
   * itself: "closed before the connection is established" in the console.
   *
   * The callback lives in a ref so the effect depends only on which file it is
   * showing, and a flag tells our own teardown apart from the editor exiting.
   */
  /*
   * Re-run whenever the query, the document or the face changes.
   *
   * `text` is in the deps and not just `needle`: the ranges point at DOM nodes,
   * so a document that arrives after you typed — or a switch to the editor and
   * back — leaves every one of them pointing at nodes that are gone. Recomputed
   * rather than kept, because a stale Range does not throw, it highlights the
   * wrong place.
   */
  useEffect(() => {
    if (!reading || !findOpen || !needle.trim()) {
      ranges.current = [];
      setHits(0);
      clearFind();
      return;
    }
    const found = findRanges(proseRef.current, needle);
    ranges.current = found;
    setHits(found.length);
    setHit((i) => (i < found.length ? i : 0));
  }, [needle, text, reading, findOpen, width, size]);

  // Paint separately from finding, so stepping through matches does not walk
  // the document again for every press of Enter.
  useEffect(() => {
    if (!findOpen) return;
    paintFind(ranges.current, hit);
  }, [hit, hits, findOpen]);

  // Highlights are a GLOBAL registry, so a viewer that forgot to clear would
  // leave its marks over the next document opened.
  useEffect(() => () => clearFind(), []);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /** Step to the next match and bring it on screen. */
  const goHit = useCallback((dir: 1 | -1) => {
    const n = ranges.current.length;
    if (!n) return;
    setHit((i) => {
      const next = stepFind(i, n, dir);
      revealFind(ranges.current[next]);
      return next;
    });
  }, []);

  /** Open the find bar and put the caret in it. Selecting what is already
   *  there, because reopening to refine is common and appending is not. */
  const openFind = useCallback(() => {
    setFindOpen(true);
    setTimeout(() => { findRef.current?.focus(); findRef.current?.select(); }, 0);
  }, []);

  /*
   * Ctrl+F, listened for on the WINDOW rather than on this panel.
   *
   * It was on the panel, and that made it unreachable in the case it is most
   * wanted: the file palette opens this viewer and stays on top, so the caret
   * is in the palette's field and the keystroke never reached the document at
   * all. Reported as the feature not being there — which, from where it was
   * pressed, it was not.
   *
   * Capture phase, so it wins before anything else claims the key; only while
   * a document is actually being rendered, so the editor face still gives Ctrl+F
   * to whatever is running in it.
   */
  useEffect(() => {
    if (!reading) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "f") return;
      e.preventDefault();
      e.stopPropagation();
      openFind();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [reading, openFind]);

  useEffect(() => {
    // No terminal while the rendered view is up: a pty for a file nobody is
    // editing is a process, a websocket and an editor session held open behind
    // a page of prose. Toggling back builds a fresh one on the same file.
    if (reading) return;
    let ours = false;
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      // The terminal's own resolved preferences, not a font stack written out
      // again here. Mine omitted the Nerd Font entirely, so every glyph a
      // statusline draws came out as a tofu box — and it would have drifted
      // from the terminal's size and family the first time either changed.
      ...termOptions(),
      theme: themeFromCss(),
      scrollback: 5000,
    });
    // Registered before anything is written: the first thing an editor sends is
    // the mode query xterm 6.0.0 dies on.
    const decrqm = answerDecrqm(term as never);
    // No WebGL renderer here, unlike the panel. That one draws from a texture
    // atlas built out of a single face, which is exactly where a Nerd Font
    // glyph borrowed from the back of the stack goes missing; the DOM renderer
    // falls back per glyph the way the browser does everywhere else. A file
    // viewer is not the surface that needs the throughput.
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    // After a frame: this dialog is fixed-positioned and has no size in the tick
    // it mounts, so a fit here measures zero and the pty is created with a
    // window an editor cannot draw into.
    requestAnimationFrame(() => fit.fit());

    const ws = new WebSocket(ptyWsUrl(peek.root, term.cols, term.rows, peek.path, peek.edit, undefined, false, false, peek.line ?? 0));
    ws.binaryType = "arraybuffer";

    /*
     * The protocol the terminal panel already speaks, rather than a second one
     * invented here.
     *
     * Input goes as `{t:"in", d}` — raw text on the wire is not a frame this
     * server reads, so every keystroke was dropped, and `:q` never reached the
     * editor. Output arrives binary. And nothing is sent before `{t:"ready"}`:
     * a resize that lands before the pty exists is a resize the pty never sees,
     * which is how a full-screen editor ends up drawing into a zero-row
     * terminal and showing nothing at all.
     */
    let ready = false;
    const pending: string[] = [];
    const send = (d: string) => {
      if (!ready || ws.readyState !== WebSocket.OPEN) { pending.push(d); return; }
      ws.send(JSON.stringify({ t: "in", d }));
    };
    /*
     * The rail's jumps go through the same socket as the keyboard, because they
     * ARE the keyboard. Three keystrokes:
     *
     *   `<Esc>` — in case the editor is in insert or has half a command typed.
     *   `:call clearmatches()` — take down anything a previous jump painted.
     *   `:<n><CR>zt` — the line, and then at the TOP of the window rather than
     *     wherever it happened to land. "It should come out right at the top": a jump that
     *     leaves the target in the middle makes you hunt for it a second time.
     *
     * What is NOT sent is a highlight over the changed lines. It was, for one
     * build, and he saw what it does to a place of a hundred and thirty-five
     * lines: `DiffChange` is a background, so the whole screen went yellow and
     * the syntax colours underneath it went away. The editor already marks
     * where you are — his cursorline, his dimming — and that is the marking
     * this should not compete with.
     */
    jump.current = (line: number) => {
      const at = Math.max(1, Math.floor(line));
      send(`\u001b:call clearmatches()\r:${at}\rzt`);
      term.focus();
    };
    const sendSize = () => {
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") { term.write(new Uint8Array(e.data as ArrayBuffer)); return; }
      let f: { t?: string; mode?: string; error?: string };
      // A string that is not a frame is not output on this socket; dropping it
      // is better than printing the server's own JSON into the file you opened.
      try { f = JSON.parse(e.data); } catch { return; }
      if (f.t === "ready") {
        ready = true;
        // The handle for "where is the cursor", when this pty is an nvim we
        // started with a socket of its own.
        if (typeof (f as { editor?: string }).editor === "string") setEditorId((f as { editor?: string }).editor!);
        // The size the pty was created with came from a fit that ran before the
        // dialog had been laid out, so the real one is sent the moment there is
        // somebody to receive it.
        fit.fit();
        sendSize();
        for (const d of pending.splice(0)) ws.send(JSON.stringify({ t: "in", d }));
        if (f.mode === "pipe") term.writeln("\x1b[2m(no pty on this host: an editor cannot draw here. Install python3 and reopen.)\x1b[0m");
        return;
      }
      if (f.t === "fatal") { setError(f.error || "the terminal could not start"); return; }
      // `exit` is the editor finishing — `:q`. The socket closes right after,
      // and `onclose` is what takes the window down.
    };
    ws.onerror = () => setError("lost the connection to the terminal");
    // The editor exited — `:q`, or it never started. Ours is a re-render or an
    // unmount, and must not be reported as the user finishing with the file.
    ws.onclose = () => { if (!ours) closeRef.current(); };

    const onData = term.onData((d) => send(d));
    const ro = new ResizeObserver(() => { fit.fit(); sendSize(); });
    ro.observe(el);
    // The point of opening it is to type in it.
    requestAnimationFrame(() => term.focus());

    return () => {
      ours = true;
      decrqm.dispose();
      ro.disconnect();
      onData.dispose();
      try { ws.close(); } catch { /* already gone */ }
      term.dispose();
    };
  }, [reading, peek.root, peek.path, peek.edit]);

  return (
    // Explicit, not left to mount order. The workspace is itself a portal, and
    // two portals at the same z are stacked by whichever effect appended last —
    // which happens to be right today and would silently invert the day this
    // opens from something that mounts earlier.
    <Portal z={LAYER.viewer}>
      {/* Escape belongs to the editor — it is a modal editor, and stealing it
          would make the pane unusable for the thing it opened. The backdrop and
          the button are the ways out that do not collide. */}
      <div className="fixed inset-0" style={{ zIndex: 9998, background: "color-mix(in srgb, var(--bg) 62%, transparent)" }}
        onClick={onClose} />
      <div role="dialog" aria-label={`${peek.edit ? "Editing" : "Viewing"} ${peek.path}`}
        className="fixed rounded-xl overflow-hidden flex flex-col"
        style={{
          zIndex: 9999, top: topPx === undefined ? "6vh" : topPx, bottom: "6vh", left: "8vw", right: "8vw",
          background: "var(--bg)",
          border: "1px solid color-mix(in srgb, var(--text) 22%, transparent)",
          boxShadow: "0 40px 90px -24px var(--shadow)",
        }}>
        <div className="flex items-center gap-2 px-3 py-1.5 shrink-0 text-[11px]"
          style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", background: "var(--bg2)" }}>
          {/* Which of the two this is, said at a glance rather than discovered
              by trying to type. A writable editor open on the wrong worktree is
              the failure worth making impossible to walk into, so the branch is
              part of the claim. */}
          <span className="shrink-0 text-[9.5px] px-1.5 py-0.5 rounded-full"
            style={peek.edit
              ? { color: "var(--success)", border: "1px solid color-mix(in srgb, var(--success) 50%, transparent)" }
              : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 20%, transparent)" }}>
            {peek.edit ? "editable" : "⌦ read-only"}
          </span>
          <span className="min-w-0 truncate" style={{ color: "var(--text)" }}>{peek.label ?? peek.path}</span>
          {peek.branch && (
            <span className="shrink-0 text-[9.5px] px-1.5 py-0.5 rounded-full truncate" style={{ maxWidth: 220, color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>
              {peek.branch}
            </span>
          )}
          {/*
            * The reading controls, and only while reading.
            *
            * They are settings OF THE VIEW, so they live with the view: showing
            * a font-size stepper over a terminal that has its own font size,
            * set somewhere else entirely, would be two knobs for one thing and
            * neither of them right.
            */}
          {reading && (
            <span className="ml-auto shrink-0 flex items-center gap-1.5">
              {/* A button as well as the key.
                  Ctrl+F is what everyone tries first and it is invisible: the
                  feature was reported as missing while it was shipped and
                  working, because there was nothing on screen that said so. The
                  key is named on it, which is also how anybody learns it. */}
              <button onClick={openFind} disabled={text === null}
                title="Find in this document (Ctrl+F)"
                className="agx-btn rounded px-2 py-0.5 text-[10px]"
                style={{ color: findOpen ? "var(--primary-hover)" : "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 20%, transparent)", opacity: text === null ? 0.4 : 1 }}>
                ⌕ Find
              </button>
              <button onClick={copy} disabled={text === null}
                title="Copy the markdown source, not the rendering"
                className="agx-btn rounded px-2 py-0.5 text-[10px]"
                style={{ color: copied ? "var(--success)" : "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 20%, transparent)", opacity: text === null ? 0.4 : 1 }}>
                {copied ? "Copied" : "Copy"}
              </button>

              {/* Size. The number is between the two buttons because it is what
                  they are moving, and because a stepper with no read-out makes
                  you press it to find out where you are. */}
              <span className="flex items-center rounded overflow-hidden"
                style={{ border: "1px solid color-mix(in srgb, var(--text) 20%, transparent)" }}>
                {/* The functional form, because two clicks in one tick both
                    read the same `size` and the second step is lost. A person
                    hammering A+ is exactly who is trying to change it a lot. */}
                <button onClick={() => setSize((n) => setMdSize(n - 1))} disabled={size <= SIZE_MIN}
                  title="Smaller" className="agx-btn px-1.5 py-0.5 text-[11px] disabled:opacity-30"
                  style={{ color: "var(--text2)" }}>A−</button>
                <span className="px-1 text-[10px] tabular-nums" style={{ color: "var(--text3)" }}>{size}</span>
                <button onClick={() => setSize((n) => setMdSize(n + 1))} disabled={size >= SIZE_MAX}
                  title="Bigger" className="agx-btn px-1.5 py-0.5 text-[11px] disabled:opacity-30"
                  style={{ color: "var(--text2)" }}>A+</button>
              </span>

              {/* Measure, in characters — the unit that stays true when the
                  size changes. See mdPrefs.ts. */}
              <span className="flex items-center rounded overflow-hidden"
                style={{ border: "1px solid color-mix(in srgb, var(--text) 20%, transparent)" }}>
                {WIDTHS.map((w) => (
                  <button key={w} onClick={() => setWidth(setMdWidth(w))}
                    title={w === 0 ? "Use the whole pane" : `${w} characters a line`}
                    className="agx-btn px-1.5 py-0.5 text-[10px]"
                    style={w === width
                      ? { background: "color-mix(in srgb, var(--primary) 22%, transparent)", color: "var(--text)" }
                      : { color: "var(--text3)" }}>
                    {widthLabel(w)}
                  </button>
                ))}
              </span>

              {/* Where it lives. Only where there is a file manager to ask —
                  a browser tab has none, and a dead button is worse than none. */}
              {canReveal() && (
                <button onClick={() => void reveal()} title="Show this file in the file manager"
                  className="agx-btn rounded px-2 py-0.5 text-[10px]"
                  style={{ color: revealed ? "var(--error)" : "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 20%, transparent)" }}>
                  {revealed ?? "Show in folder"}
                </button>
              )}
            </span>
          )}

          {/* The toggle, in both faces. It is the whole point of the feature:
              you came to read, and the moment you want to change a line the
              editor is one click away on the same file. */}
          {/* At a ref there is nothing to edit — no file on disk, only an
              object in the store — and an editor pointed at the working tree's
              path would open a DIFFERENT file wearing the right name. So the
              toggle is replaced by the fact. */}
          {atRef && (
            <span className="shrink-0 text-[10px] px-2 py-0.5 rounded ml-auto"
              title={`Read from ${peek.ref} — this checkout is not on that branch`}
              style={{ color: "var(--info)", border: "1px solid color-mix(in srgb, var(--info) 32%, transparent)" }}>
              read-only · {peek.ref}
            </span>
          )}
          {canRender && !atRef && (
            <span className={`shrink-0 flex items-center rounded overflow-hidden ${reading ? "" : "ml-auto"}`}
              style={{ border: "1px solid color-mix(in srgb, var(--text) 20%, transparent)" }}>
              <button onClick={() => setReading(true)} title="Render it as markdown"
                className="agx-btn text-[10px] px-2 py-0.5"
                style={reading
                  ? { background: "color-mix(in srgb, var(--primary) 22%, transparent)", color: "var(--text)" }
                  : { color: "var(--text3)" }}>
                Reading
              </button>
              <button onClick={() => setReading(false)} title="Open it in the editor"
                className="agx-btn text-[10px] px-2 py-0.5"
                style={!reading
                  ? { background: "color-mix(in srgb, var(--primary) 22%, transparent)", color: "var(--text)" }
                  : { color: "var(--text3)" }}>
                {peek.edit ? "Editing" : "Source"}
              </button>
            </span>
          )}
          {/*
            * Take it to the bench.
            *
            * The division the bench exists for: prose is READ here, and code is
            * EDITED there. This viewer opens with the document and dies with
            * it; a bench tab is a tmux session, so the file you send there is
            * still open — at the same line, with your undo and your jumplist —
            * after you have been to the terminal and back, or after the app has
            * been closed. That is the whole difference, and it is why this is a
            * one-click move rather than a setting.
            *
            * Offered for a ref's copy too. The copy is a real file on disk (the
            * server wrote it out), so it opens there exactly as it does here —
            * still read-only, because that is what a copy of a commit is.
            */}
          <button
            onClick={() => {
              showFile(peek.root, peek.path, {
                line: peek.line,
                readonly: !peek.edit,
                ref: peek.ref,
                title: (peek.label || peek.path).split("/").pop(),
              });
              onClose();
            }}
            title="Open this file on the bench — it stays open there when you leave this view"
            className={`agx-btn shrink-0 text-[10px] px-2 py-0.5 rounded ${canRender || atRef ? "" : "ml-auto"}`}
            style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 20%, transparent)" }}>
            To the bench
          </button>
          <span className="shrink-0" style={{ color: "var(--text3)" }}>
            {reading ? "" : peek.edit ? ":wq to save and close" : ":q to close"}
          </span>
          <CloseButton onClick={onClose} title="Close" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 18%, transparent)" }} className="agx-btn shrink-0 rounded" />
        </div>
        {error ? (
          <div className="p-4 text-[11.5px]" style={{ color: "var(--error)" }}>{error}</div>
        ) : reading ? (
          <>
          {findOpen && (
            <FindBar
              inputRef={findRef} value={needle} onValue={(v) => { setNeedle(v); setHit(0); }}
              hit={hits ? hit + 1 : 0} hits={hits}
              onStep={goHit}
              onClose={() => { setFindOpen(false); setNeedle(""); clearFind(); }} />
          )}
          {/* Rendered, and capped to a readable measure rather than run to the
              width of the dialog — a status report at 200 characters a line is
              the reason people open these in something else.

              Braced, and that is not style. A slash-star comment is a comment
              only where JSX expects an EXPRESSION; among an element's children
              it is TEXT. This one used to be unbraced, and the wrapper added
              for the find bar moved it from the first position into the second
              — so the sentence you are reading was printed on screen, above the
              document, in the shipped build. */}
          <div className="flex-1 min-h-0 overflow-y-auto agx-scroll px-6 py-5">
            <div ref={proseRef} className="agx-prose mx-auto"
              /* The measure is in `ch` of the PROSE font, which is what makes
                 66 mean sixty-six characters rather than sixty-six of some
                 other face's. See .agx-prose in index.css. */
              style={{ maxWidth: width ? `${width}ch` : "none", fontSize: size }}>
              {textErr && <div className="text-[12px]" style={{ color: "var(--error)" }}>{textErr}</div>}
              {text === null && !textErr && <div className="text-[12px] t-dim">Reading…</div>}
              {/* Markdown only for markdown. A caller that lands anything else
                  in reading mode gets it as it is: the renderer collapses
                  newlines into paragraphs, bolds a `**`, and turns backticks
                  into chips — which is a document's job and the exact opposite
                  of what code needs. Callers are supposed to send code to the
                  editor (see isRenderable), and this is the wall behind that
                  door rather than a second opinion about where code belongs. */}
              {text !== null && (canRender
                ? <Markdown text={text} />
                : <pre className="text-[12.5px] leading-relaxed whitespace-pre overflow-x-auto agx-scroll"
                    style={{ fontFamily: "var(--mono, ui-monospace, monospace)" }}>{text}</pre>)}
              {truncated && (
                <div className="mt-4 text-[11.5px]" style={{ color: "var(--warning)" }}>
                  This file is longer than a megabyte and is shown up to there. Open it in the editor
                  for the rest.
                </div>
              )}
            </div>
          </div>
          </>
        ) : (
          /*
           * The padding is on the TERMINAL, not on this box, and that is the
           * whole fix for a statusline that came out sliced.
           *
           * FitAddon works out how many rows fit from
           * `getComputedStyle(parent).height` minus the padding of the XTERM
           * element. With `box-sizing: border-box` — which this app sets
           * globally — that height INCLUDES the parent's own padding, so six
           * pixels top and bottom here were counted as usable and then were
           * not: measured at four pixels of the last row falling past the
           * bottom of its container. Padding the terminal itself is the one
           * place the addon actually looks.
           */
          <div className="flex-1 min-h-0 flex">
            <div ref={host} className="agx-peek-term flex-1 min-h-0" />
            <ChangeRail groups={peek.groups ?? []} fileLines={fileLines} cursor={cursor}
              onGo={(n) => jump.current?.(n)} />
          </div>
        )}
      </div>
    </Portal>
  );
}

/**
 * The find bar for the rendered face.
 *
 * Deliberately the shape everybody already knows — a field, a count, previous,
 * next, close — because a find bar that invents its own vocabulary is a find
 * bar you have to read before you can use.
 *
 * The count says "3 / 17" rather than "17 matches": which one you are standing
 * on is the part that tells you whether to keep pressing.
 */
function FindBar({ inputRef, value, onValue, hit, hits, onStep, onClose }: {
  inputRef: React.RefObject<HTMLInputElement>;
  value: string;
  onValue: (v: string) => void;
  hit: number;
  hits: number;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
}) {
  const none = value.trim().length > 0 && hits === 0;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 shrink-0 text-[11px]"
      style={{ borderBottom: "1px solid color-mix(in srgb, var(--text) 16%, transparent)", background: "var(--bg2)" }}>
      <span style={{ color: "var(--text3)" }}>⌕</span>
      <input ref={inputRef} value={value} onChange={(e) => onValue(e.target.value)}
        spellCheck={false} autoComplete="off" placeholder="Find in this document…"
        className="flex-1 min-w-0 bg-transparent outline-none text-[12px]"
        style={{ color: none ? "var(--error)" : "var(--text)" }}
        onKeyDown={(e) => {
          // Enter walks forward, Shift+Enter back — and they stop here, or the
          // panel's own Escape would close the document instead of the bar.
          if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onStep(e.shiftKey ? -1 : 1); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
        }} />
      {/* Which one of how many. Tabular so the numbers do not jitter as you
          step through them. */}
      <span className="tabular-nums shrink-0" style={{ color: none ? "var(--error)" : "var(--text3)" }}>
        {value.trim() ? (hits ? `${hit} / ${hits}` : "no matches") : ""}
      </span>
      <button onClick={() => onStep(-1)} disabled={!hits} title="Previous (Shift+Enter)"
        className="agx-btn shrink-0 rounded px-1.5" style={{ color: hits ? "var(--text2)" : "var(--text4)" }}>↑</button>
      <button onClick={() => onStep(1)} disabled={!hits} title="Next (Enter)"
        className="agx-btn shrink-0 rounded px-1.5" style={{ color: hits ? "var(--text2)" : "var(--text4)" }}>↓</button>
      <CloseButton onClick={onClose} title="Close find (esc)"
        style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--text) 18%, transparent)" }}
        className="agx-btn shrink-0 rounded" />
    </div>
  );
}
