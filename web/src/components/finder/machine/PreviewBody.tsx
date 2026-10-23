// What the preview panel shows of a file, by what the file is: read by default
// for any text (line numbers, colour, long lines wrap inside the pane), markdown
// rendered, a page in an isolated frame, JSON as text / tree / graph, pictures,
// PDF, audio and video in their own viewers, and a plain message for a binary.
// The "Editing" tab is nvim running in this pane (FinderNvim); the header's "Open in nvim" is the bench.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { Markdown } from "../../../lib/markdown.tsx";
import { useDiffHighlight } from "../../../lib/diffHighlight.ts";
import { humanBytes } from "../../../lib/paletteModel.ts";
import {
  COLOUR_LINES, GRAPH_MAX_BYTES, HTML_RENDER_MAX_BYTES, JSON_READ_CAP, READ_LINES,
  graphAllowed, htmlRenderable, isolatedDoc, nextReadWidth, previewPlan, readMaxWidth, readWidthLabel, readWindow, sortedOrder, type ReadWidth, type PreviewTab,
} from "../../../lib/finderPreview.ts";
import { HIT } from "../../../lib/iconSize.ts";
import type { FileFacts } from "../../../../../shared/types.ts";
import { EDGE } from "../../workspace/Chrome.tsx";
import { CODE_FONT_STYLE } from "../../diff/DiffLines.tsx";
import { JsonGraph, JsonTree } from "./JsonViews.tsx";
import { BarButton, PreviewBar } from "./PreviewBar.tsx";
import { FinderNvim } from "./FinderNvim.tsx";
import { editability } from "../../../lib/finderEdit.ts";
import { FindBar } from "../../PeekFile.tsx";
import { clear as clearFind, findRanges, paint as paintFind, reveal as revealFind, step as stepFind } from "../../../lib/mdFind.ts";
import { SearchIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";

const note = (children: React.ReactNode, warn = false) => (
  <p className="m-0 mb-2 text-[11px]" style={{ color: warn ? "var(--warning-ink)" : "var(--text3)" }}>{children}</p>
);

/** What the panel hands the body so the header bar can carry the view's own tools. */
export interface BarProps { lead: React.ReactNode; name: string; meta: string; title: string; onClose?: () => void; onOpen?: () => void; onNvim?: () => void }

/** Print what the pane shows: its markup in a hidden frame, so nothing else of the page is on the sheet. */
function printPane(el: HTMLElement | null, title: string) {
  if (!el) return;
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
  f.srcdoc = `<!doctype html><meta charset="utf-8"><title>${title.replace(/[<&]/g, "")}</title><style>body{font:12px/1.5 ui-monospace,monospace;color:#000;background:#fff;white-space:pre-wrap;overflow-wrap:anywhere}</style>${el.innerHTML}`;
  f.onload = () => { f.contentWindow?.print(); setTimeout(() => f.remove(), 1000); };
  document.body.appendChild(f);
}

export function PreviewBody({ path, facts, canEdit, root, onEditing, savedTab, onTab, bar, readW, onReadW }: {
  readW: ReadWidth; onReadW: (w: ReadWidth) => void;
  bar: BarProps;
  path: string;
  /** The workspace the editor session hangs off (the bench's own key). */
  root: string;
  /** Which file nvim is on while Editing is the open tab, null otherwise: the Finder guards its exits by it. */
  onEditing: (path: string | null) => void;
  /** The view this file was last on, and where to say it changed. */
  savedTab?: { path: string; tab: string };
  onTab: (path: string, tab: string) => void;
  facts: FileFacts;
  canEdit: boolean;
}) {
  const plan = useMemo(() => previewPlan(facts), [facts]);
  const firstTab = (): PreviewTab => (savedTab && savedTab.path === path && (plan.tabs as string[]).includes(savedTab.tab) ? (savedTab.tab as PreviewTab) : (plan.tabs[0] ?? "Reading"));
  const [tab, setTabNow] = useState<PreviewTab>(firstTab);
  const setTab = (t: PreviewTab) => { setTabNow(t); onTab(path, t); };
  useEffect(() => setTabNow(firstTab()), [path, plan]);
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [path]);
  const mayEdit = canEdit && editability(facts);
  const editorOn = editing && !!mayEdit && mayEdit.ok;
  useEffect(() => { onEditing(editorOn ? path : null); return () => onEditing(null); }, [editorOn, path]);
  const graphOk = graphAllowed(facts.bytes);
  const texty = plan.viewer === "code" || plan.viewer === "markdown" || plan.viewer === "html" || plan.viewer === "json";

  /* Wrap long lines (the default: nothing in the pane may be wider than it) or scroll them. */
  const [wrap, setWrap] = useState(true);
  /* Find in the preview, painted beside the DOM so the document is never touched (lib/mdFind). */
  const bodyRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [needle, setNeedle] = useState("");
  const [hit, setHit] = useState(0);
  const [hits, setHits] = useState(0);
  useEffect(() => { setFindOpen(false); setNeedle(""); clearFind(); }, [path]);
  useEffect(() => {
    if (!findOpen || !needle.trim()) { ranges.current = []; setHits(0); clearFind(); return; }
    const found = findRanges(bodyRef.current, needle);
    ranges.current = found; setHits(found.length); setHit((i) => (i < found.length ? i : 0));
  }, [needle, findOpen, tab, path, facts.text, wrap]);
  useEffect(() => { if (findOpen) paintFind(ranges.current, hit); }, [hit, hits, findOpen]);
  useEffect(() => () => clearFind(), []);
  const goHit = useCallback((dir: 1 | -1) => {
    const n = ranges.current.length;
    if (!n) return;
    setHit((i) => { const next = stepFind(i, n, dir); revealFind(ranges.current[next]); return next; });
  }, []);

  /* Two ways to see a file (rendered / source) are one toggle in the bar, as in Strata; JSON's three stay a row. */
  const toggles = plan.tabs.length === 2;
  const other = toggles ? plan.tabs.find((t) => t !== tab) ?? plan.tabs[0]! : tab;
  const showsSource = tab === "Source" || tab === "Reading";
  const tabs = (plan.tabs.length > 2 || (canEdit && plan.tabs.length > 0 && !toggles)) && (
    <div className="flex items-center gap-1 px-4 pt-2 shrink-0" role="tablist" aria-label="How to show this file">
      {plan.tabs.length > 2 && plan.tabs.map((t) => {
        const off = t === "Graph" && !graphOk;
        return (
          <button key={t} role="tab" aria-selected={!editing && tab === t} disabled={off} className="agx-btn px-2.5 rounded-md text-[11px] disabled:opacity-40"
            title={off ? `Graph is for JSON under ${humanBytes(GRAPH_MAX_BYTES)}` : undefined}
            style={{ minHeight: HIT - 6, border: EDGE, ...(!editing && tab === t ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)", color: "var(--text)" } : { color: "var(--text3)" }) }}
            onClick={() => { setEditing(false); setTab(t); }}>{t}</button>
        );
      })}
      {canEdit && (
        <button role="tab" aria-selected={editing} disabled={!mayEdit || !mayEdit.ok} className="agx-btn px-2.5 rounded-md text-[11px] disabled:opacity-40"
          style={{ minHeight: HIT - 6, border: EDGE, ...(editing ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)", color: "var(--text)" } : { color: "var(--text3)" }) }}
          title={mayEdit && !mayEdit.ok ? mayEdit.why : "Edit this file with nvim, here"} onClick={() => setEditing(true)}>Editing</button>
      )}
    </div>
  );
  const tools = (
    <>
      {toggles && <BarButton icon="file-code" label={showsSource ? `Show ${other.toLowerCase()}` : "Show source"} on={showsSource} onClick={() => { setEditing(false); setTab(other); }} />}
      {texty && !editing && <BarButton icon="search" label="Find in preview" on={findOpen} onClick={() => { setFindOpen((o) => !o); setTimeout(() => findRef.current?.focus(), 0); }} />}
      {(plan.viewer === "markdown" || plan.viewer === "code") && !editing && (
        <button type="button" className="agx-btn rounded-md px-1.5 text-[10.5px] shrink-0" style={{ height: HIT - 4, minWidth: HIT - 4, color: "var(--text3)", border: EDGE }} title={`Reading width: ${readWidthLabel(readW)} (press to change)`} aria-label={`Reading width ${readWidthLabel(readW)}`}
          onClick={() => onReadW(nextReadWidth(readW))}>{readWidthLabel(readW)}</button>
      )}
      {bar.onNvim && <BarButton icon="terminal" label="Open in nvim" onClick={bar.onNvim} />}
    </>
  );
  const afterTools = texty && !editing ? <BarButton icon="wrap-text" label="Wrap long lines" on={wrap} onClick={() => setWrap((w) => !w)} /> : null;

  let body: React.ReactNode;
  if (editorOn) body = <FinderNvim root={root} path={path} onEnd={() => setEditing(false)} />;
  else switch (plan.viewer) {
    case "markdown": body = tab === "Source" ? <Reading facts={facts} name={facts.name} wrap={wrap} readW={readW} /> : <MarkdownView facts={facts} readW={readW} />; break;
    case "html": body = tab === "Rendered" ? <HtmlFrame path={path} bytes={facts.bytes} /> : <Reading facts={facts} name={facts.name} wrap={wrap} />; break;
    case "json": body = tab === "Reading" ? <Reading facts={facts} name={facts.name} wrap={wrap} /> : <JsonData path={path} bytes={facts.bytes} graph={tab === "Graph"} />; break;
    case "code": body = <Reading facts={facts} name={facts.name} wrap={wrap} readW={readW} />; break;
    case "image": body = <Picture src={api.previewUrl(path)} facts={facts} />; break;
    case "convert": body = <Converted path={path} facts={facts} />; break;
    case "pdf": body = <iframe title={facts.name} src={api.previewUrl(path)} className="w-full flex-1" style={{ border: EDGE, borderRadius: 6, minHeight: 360, background: "var(--bg)" }} />; break;
    case "audio": body = <audio src={api.previewUrl(path)} controls preload="metadata" className="w-full" aria-label={facts.name} />; break;
    case "video": body = <video src={api.previewUrl(path)} controls preload="metadata" className="w-full" style={{ maxHeight: "60vh", borderRadius: 6 }} aria-label={facts.name} />; break;
    default: body = <p style={{ color: "var(--text3)" }}><b>{facts.name}</b> is a binary file ({humanBytes(facts.bytes)}): there is no text to show. “Open in Files” hands it to the desktop.</p>;
  }
  return (
    <>
      <PreviewBar lead={bar.lead} name={bar.name} meta={bar.meta} title={bar.title} tools={tools} afterPrint={afterTools} onOpen={bar.onOpen} onPrint={texty ? () => printPane(bodyRef.current, bar.name) : undefined} onClose={bar.onClose} />
      {tabs}
      {findOpen && (
        <div className="mt-2">
          <FindBar inputRef={findRef} value={needle} onValue={(v) => { setNeedle(v); setHit(0); }} hit={hits ? hit + 1 : 0} hits={hits} onStep={goHit}
            onClose={() => { setFindOpen(false); setNeedle(""); clearFind(); }} />
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col agx-scroll overflow-y-auto overflow-x-hidden px-4 py-3 text-[12px]">
        <div ref={bodyRef} data-selectable className="flex-1 min-w-0 min-h-0 flex flex-col" style={wrap ? undefined : { overflowX: "auto" }}>{body}</div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ text */

function Reading({ facts, name, wrap = true, readW }: { facts: FileFacts; name: string; wrap?: boolean; readW?: ReadWidth }) {
  const text = facts.text ?? "";
  const { lines, more } = useMemo(() => readWindow(text, READ_LINES), [text]);
  const { hilite } = useDiffHighlight(name);
  const tokens = useMemo(() => {
    if (!hilite.hl || !hilite.lang || !hilite.theme || lines.length > COLOUR_LINES) return null;
    try { return hilite.hl.codeToTokens(lines.join("\n"), { lang: hilite.lang as never, theme: hilite.theme }).tokens; } catch { return null; }
  }, [hilite, lines]);
  const cut = more > 0 || !!facts.textTruncated;
  return (
    <>
      <div role="region" aria-label="File text" className="text-[11.5px] leading-[1.55] min-w-0" style={{ ...CODE_FONT_STYLE, ...(readW ? { maxWidth: readMaxWidth(readW) } : {}) }}>
        {lines.map((l, i) => (
          <div key={i} className="flex min-w-0">
            <span aria-hidden className="shrink-0 select-none text-right mr-2.5" style={{ width: `${String(lines.length).length + 1}ch`, color: "var(--text4)" }}>{i + 1}</span>
            <span className="min-w-0" style={{ whiteSpace: wrap ? "pre-wrap" : "pre", overflowWrap: wrap ? "anywhere" : undefined, color: "var(--text)" }}>
              {tokens?.[i]?.length
                ? tokens[i]!.map((t, k) => <span key={k} style={{ color: t.color, fontStyle: t.fontStyle && t.fontStyle & 1 ? "italic" : undefined, fontWeight: t.fontStyle && t.fontStyle & 2 ? 700 : undefined }}>{t.content}</span>)
                : l || " "}
            </span>
          </div>
        ))}
      </div>
      {cut && <p className="mt-2 text-[11px]" style={{ color: "var(--text3)" }}>First {lines.length} lines of {humanBytes(facts.bytes)} shown. Open in nvim for the rest.</p>}
    </>
  );
}

/** Strata draws markdown in the monospace face, a centred column, the title in the accent, under a notice that raw HTML stays text. A table's header sorts its rows. */
function MarkdownView({ facts, readW }: { facts: FileFacts; readW: ReadWidth }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const undo: (() => void)[] = [];
    root.querySelectorAll("table").forEach((table) => {
      const body = table.tBodies[0];
      if (!body) return;
      let at = -1, dir: "asc" | "desc" = "asc";
      table.querySelectorAll("th").forEach((th, col) => {
        const arrow = document.createElement("span");
        arrow.setAttribute("aria-hidden", "true");
        arrow.style.cssText = "display:inline-block;width:1ch;margin-left:0.4ch;opacity:0.7";
        th.appendChild(arrow);
        th.style.cursor = "pointer";
        th.setAttribute("aria-sort", "none");
        const on = () => {
          dir = at === col && dir === "asc" ? "desc" : "asc"; at = col;
          const rows = [...body.rows];
          for (const i of sortedOrder(rows.map((r) => r.cells[col]?.textContent ?? ""), dir)) body.appendChild(rows[i]!);
          table.querySelectorAll("th").forEach((h, k) => { const a = h.lastElementChild as HTMLElement | null; if (a) a.textContent = k === col ? (dir === "asc" ? "↑" : "↓") : ""; h.setAttribute("aria-sort", k === col ? (dir === "asc" ? "ascending" : "descending") : "none"); });
        };
        th.addEventListener("click", on);
        undo.push(() => { th.removeEventListener("click", on); arrow.remove(); });
      });
    });
    return () => undo.forEach((f) => f());
  }, [facts.text]);
  return (
    <div className="min-w-0 flex flex-col gap-3" style={CODE_FONT_STYLE}>
      <div role="note" className="rounded-md px-2.5 py-1.5 text-[11px]" style={{ border: EDGE, background: "var(--surface-card)", color: "var(--text2)" }}>Raw HTML is shown as inert text in Markdown previews.</div>
      <div ref={ref} className="agx-prose agx-prose-pane agx-strata-md mx-auto w-full min-w-0" style={{ ...CODE_FONT_STYLE, fontSize: 11.5, maxWidth: readMaxWidth(readW), overflowWrap: "anywhere" }}>
        <Markdown text={facts.text ?? ""} />
        {facts.textTruncated && note(`Only the first part of this ${humanBytes(facts.bytes)} file is rendered. Open in nvim for the rest.`, true)}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

function HtmlFrame({ path, bytes }: { path: string; bytes: number }) {
  const [doc, setDoc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ok = htmlRenderable(bytes);
  useEffect(() => {
    setDoc(null); setErr(null);
    if (!ok) return;
    let live = true;
    void api.previewText(path, HTML_RENDER_MAX_BYTES).then((r) => { if (!live) return; if (r.ok) setDoc(isolatedDoc(r.text)); else setErr(r.error); });
    return () => { live = false; };
  }, [path, ok]);
  if (!ok) return note(`This page is ${humanBytes(bytes)}, over the ${humanBytes(HTML_RENDER_MAX_BYTES)} the finder draws. The Source tab reads it; “Open in Files” opens it.`, true);
  if (err) return note(`Not shown: ${err}.`, true);
  if (doc === null) return <p style={{ color: "var(--text3)" }}>Reading…</p>;
  return (
    <>
      {note("Drawn in an isolated frame: no scripts, no network, no access to agentglass.")}
      <iframe title="Rendered page" sandbox="" referrerPolicy="no-referrer" srcDoc={doc} className="w-full flex-1"
        style={{ border: EDGE, borderRadius: 6, minHeight: 360, background: "white", colorScheme: "light" }} />
    </>
  );
}

/* ------------------------------------------------------------------ json */

function JsonData({ path, bytes, graph }: { path: string; bytes: number; graph: boolean }) {
  const [state, setState] = useState<{ data: unknown } | { error: string } | null>(null);
  const fits = bytes <= JSON_READ_CAP;
  useEffect(() => {
    setState(null);
    if (!fits) return;
    let live = true;
    void api.previewText(path, JSON_READ_CAP).then((r) => {
      if (!live) return;
      if (!r.ok) return setState({ error: r.error });
      try { setState({ data: JSON.parse(r.text) }); } catch { setState({ error: "this is not valid JSON, so there is no tree; the Reading tab shows the text" }); }
    });
    return () => { live = false; };
  }, [path, fits]);
  if (!fits) return note(`This file is ${humanBytes(bytes)}; Tree and Graph read up to ${humanBytes(JSON_READ_CAP)}. The Reading tab shows its start.`, true);
  if (!state) return <p style={{ color: "var(--text3)" }}>Reading…</p>;
  if ("error" in state) return note(`Not shown: ${state.error}.`, true);
  return graph ? <JsonGraph data={state.data} /> : <JsonTree data={state.data} />;
}

/* ----------------------------------------------------------------- media */

const CHECKER = "repeating-conic-gradient(color-mix(in srgb, var(--text) 8%, transparent) 0 25%, transparent 0 50%) 0 0 / 16px 16px";

function Picture({ src, facts }: { src: string; facts: FileFacts }) {
  return (
    <>
      <div className="p-2 rounded-md min-w-0 self-start max-w-full" style={{ border: EDGE, background: CHECKER }}>
        <img alt={facts.name} src={src} style={{ maxWidth: "100%", maxHeight: 420, display: "block" }} />
      </div>
      <p className="mt-2 text-[11px]" style={{ color: "var(--text3)" }}>{facts.width && facts.height ? `${facts.width} × ${facts.height} px · ` : ""}{facts.mime} · {humanBytes(facts.bytes)}</p>
    </>
  );
}

/** A format the browser cannot draw: the server converts it first, so it comes as a blob. */
function Converted({ path, facts }: { path: string; facts: FileFacts }) {
  const [out, setOut] = useState<{ url: string } | { error: string } | null>(null);
  useEffect(() => {
    setOut(null);
    if (!facts.converter) return;
    let live = true, made: string | null = null;
    void api.previewBlob(path).then((r) => { if (!live) { if (r.ok) URL.revokeObjectURL(r.url); return; } if (r.ok) { made = r.url; setOut({ url: r.url }); } else setOut({ error: r.error }); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path, facts.converter]);
  if (!facts.converter) return note("This format needs converting and this machine has no tool for it (magick, convert, heif-convert or ffmpeg).", true);
  if (!out) return <p style={{ color: "var(--text3)" }}>Converting…</p>;
  if ("error" in out) return note(`Not shown: ${out.error}.`, true);
  return <Picture src={out.url} facts={facts} />;
}
