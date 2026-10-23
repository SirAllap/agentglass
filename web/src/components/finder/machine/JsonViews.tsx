// The Tree and Graph tabs of a JSON file in the Machine preview. The data
// decisions (rows, search, layout) are in lib/jsonView.ts; this draws them.
import { useMemo, useRef, useState } from "react";
import { GRAPH_MARGIN, elide, graphFrame, graphLayout, searchTree, visibleRows, type JsonKind } from "../../../lib/jsonView.ts";
import { CopyIcon } from "../../../lib/glyphIcons.tsx";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { EDGE, INPUT, INPUT_STYLE, LINE } from "../../workspace/Chrome.tsx";
import { CODE_FONT_STYLE } from "../../diff/DiffLines.tsx";

const INK: Record<JsonKind | "more", string> = {
  object: "var(--text2)", array: "var(--text2)", string: "var(--success-ink)", number: "var(--info-ink)",
  boolean: "var(--warning-ink)", null: "var(--text3)", more: "var(--text3)",
};
/** Rows drawn at once. A fully expanded document is folded back past this. */
const MAX_ROWS = 3000;

export function JsonTree({ data }: { data: unknown }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(["$"]));
  const [picked, setPicked] = useState("$");
  const [needle, setNeedle] = useState("");
  const [copied, setCopied] = useState(false);
  const found = useMemo(() => searchTree(data, needle), [data, needle]);
  const expanded = useMemo(() => (found.open.size ? new Set([...open, ...found.open]) : open), [open, found]);
  const rows = useMemo(() => visibleRows(data, expanded), [data, expanded]);
  const toggle = (path: string) => setOpen((cur) => { const n = new Set(cur); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  const copy = () => { void navigator.clipboard?.writeText(picked).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => { /* no permission */ }); };
  return (
    <div className="flex flex-col min-w-0 min-h-0 h-full">
      <div className="flex flex-wrap items-center gap-2 pb-2 shrink-0">
        <input value={needle} onChange={(e) => setNeedle(e.target.value)} placeholder="Search keys and values…" aria-label="Search the tree" spellCheck={false}
          className={`${INPUT} min-w-0 flex-1`} style={{ ...INPUT_STYLE, minWidth: 120 }} />
        {needle.trim() && <span className="text-[11px] tabular-nums" style={{ color: "var(--text3)" }}>{found.paths.size} {found.paths.size === 1 ? "match" : "matches"}</span>}
      </div>
      <div className="flex items-center gap-2 pb-2 shrink-0 min-w-0">
        <code className="min-w-0 flex-1 text-[11.5px]" style={{ color: "var(--text2)", overflowWrap: "anywhere" }} aria-label="Selected path">{picked}</code>
        <button className="agx-btn inline-flex items-center gap-1.5 px-2 rounded-md text-[11px] shrink-0" style={{ minHeight: HIT, border: EDGE, color: copied ? "var(--success-ink)" : "var(--text2)" }} onClick={copy}>
          <CopyIcon size={ICON.sm} />{copied ? "Copied" : "Copy path"}
        </button>
      </div>
      <div role="tree" aria-label="JSON tree" className="min-w-0 text-[11.5px] leading-[1.55]" style={{ ...CODE_FONT_STYLE, borderTop: LINE, paddingTop: 6 }}>
        {rows.slice(0, MAX_ROWS).map((r) => r.kind === "more" ? (
          <div key={r.path} style={{ paddingLeft: r.depth * 14 + 18, color: INK.more }}>… {r.more} more, not listed</div>
        ) : (
          <div key={r.path} role="treeitem" aria-expanded={r.hasKids ? r.open : undefined} aria-selected={picked === r.path}
            onClick={() => { setPicked(r.path); if (r.hasKids) toggle(r.path); }}
            className="flex gap-1 cursor-pointer rounded-sm min-w-0"
            style={{ paddingLeft: r.depth * 14, background: picked === r.path ? "color-mix(in srgb, var(--primary) 16%, transparent)" : found.paths.has(r.path) ? "color-mix(in srgb, var(--warning) 22%, transparent)" : undefined }}>
            <span aria-hidden className="shrink-0 text-center select-none" style={{ width: 14, color: "var(--text3)" }}>{r.hasKids ? (r.open ? "▾" : "▸") : ""}</span>
            <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>
              {r.key !== null && <span style={{ color: "var(--text)" }}>{typeof r.key === "number" ? r.key : elide(String(r.key), 80)}<span style={{ color: "var(--text3)" }}>: </span></span>}
              {r.summary !== undefined
                ? <span style={{ color: INK[r.kind] }}>{r.kind === "array" ? "[" : "{"}<span style={{ color: "var(--text3)" }}> {r.summary} </span>{r.kind === "array" ? "]" : "}"}</span>
                : <span style={{ color: INK[r.kind] }}>{r.text}</span>}
            </span>
          </div>
        ))}
        {rows.length > MAX_ROWS && <div style={{ color: INK.more, paddingTop: 4 }}>… {rows.length - MAX_ROWS} more rows. Fold a branch to see them.</div>}
      </div>
    </div>
  );
}

const FONT = '10.5px ui-monospace, "SF Mono", Menlo, monospace';

export function JsonGraph({ data }: { data: unknown }) {
  const ctx = useRef<CanvasRenderingContext2D | null>(null);
  const g = useMemo(() => {
    if (!ctx.current) { ctx.current = document.createElement("canvas").getContext("2d"); if (ctx.current) ctx.current.font = FONT; }
    const c = ctx.current;
    return graphLayout(data, (t) => (c ? c.measureText(t).width : t.length * 6.4));
  }, [data]);
  const frame = graphFrame(g);
  const [fit, setFit] = useState(true);
  return (
    <div className="flex flex-col min-w-0 min-h-0 h-full gap-2">
      <p className="m-0 text-[11px]" style={{ color: "var(--text3)" }}>
        Each object and array is a box sized to its own text; what it nests is the next column. Values are cut inside their box.
        {g.omitted > 0 && ` ${g.omitted} more boxes are not drawn (the first ${g.maxNodes} are).`}
        <button type="button" className="agx-btn ml-2 px-2 rounded-md text-[10.5px]" style={{ minHeight: HIT - 8, border: EDGE, color: "var(--text2)" }}
          aria-pressed={!fit} onClick={() => setFit((v) => !v)} title={fit ? "Draw at full size and scroll" : "Fit the whole graph in the pane"}>{fit ? "Full size" : "Fit"}</button>
      </p>
      <div className="min-w-0 min-h-0 flex-1 agx-scroll overflow-auto rounded-lg" style={{ border: EDGE, background: "var(--bg)", maxWidth: "100%" }}>
        <svg role="img" aria-label="JSON graph" viewBox={`0 0 ${frame.w} ${frame.h}`} style={{ display: "block", ...(fit ? { width: "100%", maxWidth: frame.w, height: "auto" } : { width: frame.w, height: frame.h }), fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: 10.5 }}>
          <g transform={`translate(${GRAPH_MARGIN},${GRAPH_MARGIN})`}>
            {g.edges.map((e) => {
              const a = g.nodes[e.from]!, b = g.nodes[e.to]!;
              const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + 12, mx = (x1 + x2) / 2;
              return <path key={`${e.from}-${e.to}`} d={`M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} fill="none" style={{ stroke: "var(--text4)" }} strokeWidth={1} />;
            })}
            {g.nodes.map((n) => (
              <g key={n.id} transform={`translate(${n.x},${n.y})`}>
                <rect width={n.w} height={n.h} rx={6} style={{ fill: "var(--surface-card)", stroke: "var(--surface-line)" }} />
                <text x={10} y={16} fontWeight={700} style={{ fill: "var(--text)" }}>{n.title}</text>
                {n.rows.map((r, i) => <text key={i} x={10} y={36 + i * 16} style={{ fill: "var(--text2)" }}>{r}</text>)}
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}
