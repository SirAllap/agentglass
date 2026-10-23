// What the preview panel shows of a file, by what the file is: read by default
// for any text (line numbers, colour, long lines wrap inside the pane), markdown
// rendered, a page in an isolated frame, JSON as text / tree / graph, pictures,
// PDF, audio and video in their own viewers, and a plain message for a binary.
// The "Editing" tab edits a small text file in place (FileEditor); "Open in nvim" is the bench, for the rest.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { Markdown } from "../../../lib/markdown.tsx";
import { useDiffHighlight } from "../../../lib/diffHighlight.ts";
import { humanBytes } from "../../../lib/paletteModel.ts";
import {
  COLOUR_LINES, GRAPH_MAX_BYTES, HTML_RENDER_MAX_BYTES, JSON_READ_CAP, READ_LINES,
  graphAllowed, htmlRenderable, isolatedDoc, previewPlan, readWindow, type PreviewTab,
} from "../../../lib/finderPreview.ts";
import { HIT } from "../../../lib/iconSize.ts";
import type { FileFacts } from "../../../../../shared/types.ts";
import { EDGE } from "../../workspace/Chrome.tsx";
import { CODE_FONT_STYLE } from "../../diff/DiffLines.tsx";
import { JsonGraph, JsonTree } from "./JsonViews.tsx";
import { FileEditor } from "./FileEditor.tsx";
import { editability, getDraft } from "../../../lib/finderEdit.ts";
import { FindBar } from "../../PeekFile.tsx";
import { clear as clearFind, findRanges, paint as paintFind, reveal as revealFind, step as stepFind } from "../../../lib/mdFind.ts";
import { SearchIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";

const note = (children: React.ReactNode, warn = false) => (
  <p className="m-0 mb-2 text-[11px]" style={{ color: warn ? "var(--warning-ink)" : "var(--text3)" }}>{children}</p>
);

export function PreviewBody({ path, facts, canEdit, onBench }: {
  path: string;
  facts: FileFacts;
  canEdit: boolean;
  onBench: () => void;
}) {
  const plan = useMemo(() => previewPlan(facts), [facts]);
  const [tab, setTab] = useState<PreviewTab>(plan.tabs[0] ?? "Reading");
  useEffect(() => setTab(plan.tabs[0] ?? "Reading"), [path, plan]);
  /* A file with an unsaved edit comes back in the editor. */
  const [editing, setEditing] = useState(() => !!getDraft(path));
  useEffect(() => setEditing(!!getDraft(path)), [path]);
  const mayEdit = canEdit && editability(facts);
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

  const tabs = plan.tabs.length > 0 && (
    <div className="flex items-center gap-1 pb-2 shrink-0" role="tablist" aria-label="How to show this file">
      {plan.tabs.map((t) => {
        const off = t === "Graph" && !graphOk;
        return (
          <button key={t} role="tab" aria-selected={!editing && tab === t} disabled={off} className="agx-btn px-2.5 rounded-md text-[11px] disabled:opacity-40"
            title={off ? `Graph is for JSON under ${humanBytes(GRAPH_MAX_BYTES)}` : undefined}
            style={{ minHeight: HIT - 6, border: EDGE, ...(!editing && tab === t ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)", color: "var(--text)" } : { color: "var(--text3)" }) }}
            onClick={() => { setEditing(false); setTab(t); }}>{t}</button>
        );
      })}
      {canEdit && (
        <>
          <button role="tab" aria-selected={editing} disabled={!mayEdit || !mayEdit.ok} className="agx-btn px-2.5 rounded-md text-[11px] disabled:opacity-40"
            style={{ minHeight: HIT - 6, border: EDGE, ...(editing ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)", color: "var(--text)" } : { color: "var(--text3)" }) }}
            title={mayEdit && !mayEdit.ok ? mayEdit.why : "Edit this file here; Ctrl+S saves"} onClick={() => setEditing(true)}>Editing</button>
          <button className="agx-btn px-2.5 rounded-md text-[11px]" style={{ minHeight: HIT - 6, border: EDGE, color: "var(--text3)" }}
            onClick={onBench} title="Open the file in nvim on the bench">Open in nvim</button>
        </>
      )}
      {texty && !editing && (
        <span className="ml-auto flex items-center gap-1">
          <button className="agx-btn px-2 rounded-md text-[11px] inline-flex items-center gap-1" aria-pressed={findOpen} title="Find in preview"
            style={{ minHeight: HIT - 6, border: EDGE, color: findOpen ? "var(--primary-ink)" : "var(--text3)" }}
            onClick={() => { setFindOpen((o) => !o); setTimeout(() => findRef.current?.focus(), 0); }}><SearchIcon size={ICON.xs} />Find</button>
          <button className="agx-btn px-2 rounded-md text-[11px]" aria-pressed={wrap} title="Toggle word wrap"
            style={{ minHeight: HIT - 6, border: EDGE, color: wrap ? "var(--text)" : "var(--text3)" }} onClick={() => setWrap((w) => !w)}>Wrap</button>
        </span>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (editing && mayEdit && mayEdit.ok) body = <FileEditor path={path} facts={facts} onDone={() => setEditing(false)} />;
  else switch (plan.viewer) {
    case "markdown": body = tab === "Source" ? <Reading facts={facts} name={facts.name} wrap={wrap} /> : <MarkdownView facts={facts} />; break;
    case "html": body = tab === "Rendered" ? <HtmlFrame path={path} bytes={facts.bytes} /> : <Reading facts={facts} name={facts.name} wrap={wrap} />; break;
    case "json": body = tab === "Reading" ? <Reading facts={facts} name={facts.name} wrap={wrap} /> : <JsonData path={path} bytes={facts.bytes} graph={tab === "Graph"} />; break;
    case "code": body = <Reading facts={facts} name={facts.name} wrap={wrap} />; break;
    case "image": body = <Picture src={api.previewUrl(path)} facts={facts} />; break;
    case "convert": body = <Converted path={path} facts={facts} />; break;
    case "pdf": body = <iframe title={facts.name} src={api.previewUrl(path)} className="w-full flex-1" style={{ border: EDGE, borderRadius: 6, minHeight: 360, background: "var(--bg)" }} />; break;
    case "audio": body = <audio src={api.previewUrl(path)} controls preload="metadata" className="w-full" aria-label={facts.name} />; break;
    case "video": body = <video src={api.previewUrl(path)} controls preload="metadata" className="w-full" style={{ maxHeight: "60vh", borderRadius: 6 }} aria-label={facts.name} />; break;
    default: body = <p style={{ color: "var(--text3)" }}><b>{facts.name}</b> is a binary file ({humanBytes(facts.bytes)}): there is no text to show. “Open in Files” hands it to the desktop.</p>;
  }
  return (
    <div className="flex flex-col min-w-0 min-h-full">
      {tabs}
      {findOpen && (
        <div className="-mx-4 mb-2">
          <FindBar inputRef={findRef} value={needle} onValue={(v) => { setNeedle(v); setHit(0); }} hit={hits ? hit + 1 : 0} hits={hits} onStep={goHit}
            onClose={() => { setFindOpen(false); setNeedle(""); clearFind(); }} />
        </div>
      )}
      <div ref={bodyRef} className="flex-1 min-w-0 min-h-0 flex flex-col" style={wrap ? undefined : { overflowX: "auto" }}>{body}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ text */

function Reading({ facts, name, wrap = true }: { facts: FileFacts; name: string; wrap?: boolean }) {
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
      <div role="region" aria-label="File text" className="text-[11.5px] leading-[1.55] min-w-0" style={CODE_FONT_STYLE}>
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

function MarkdownView({ facts }: { facts: FileFacts }) {
  return (
    <div className="agx-prose agx-prose-pane min-w-0" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
      <Markdown text={facts.text ?? ""} />
      {facts.textTruncated && note(`Only the first part of this ${humanBytes(facts.bytes)} file is rendered. Open in nvim for the rest.`, true)}
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
