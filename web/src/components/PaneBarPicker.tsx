import type { PaneBarMode } from "../lib/paneChip.ts";
import type { PaneMarker } from "../lib/paneActionsPref.ts";
import { EDGE, LINE } from "./workspace/Chrome.tsx";

/*
 * Settings > Terminal > Pane bar: three cards, each a small live picture of the
 * thing it picks, and Off. Hover a card and its picture does what the real one
 * does (the bar slides up, the pill opens, the strip stays). Under Edge line a
 * two-way choice of marker, shown only while Edge line is the one picked.
 */

const LINES = [70, 45, 60, 52, 30, 12];
const STATUS = "⏵⏵ bypass permissions on (shift+tab to cycle)";

/** The bar in miniature: kind tile, branch, a few parts. Drawn, not rendered from the
 *  real component, so a picture costs nothing and cannot draw a hover card. */
function MiniChip({ w = "100%" }: { w?: string }) {
  return (
    <div className="flex items-center gap-1 rounded-md px-1 leading-none t-mono" style={{ fontSize: 6, width: w, height: 12, background: "var(--surface-card)", border: EDGE, color: "var(--text3)" }}>
      <span className="rounded-sm" style={{ width: 8, height: 8, background: "color-mix(in srgb, var(--accent, var(--primary)) 18%, transparent)" }} />
      <span className="flex-1 overflow-hidden whitespace-nowrap" style={{ color: "var(--text2)" }}>retry-webhook-delivery</span>
      <span>↑2</span><span style={{ color: "var(--warning-ink)" }}>ORBIT-1042</span>
      <span style={{ color: "var(--success-ink)" }}>#318 ●</span><span style={{ color: "var(--warning-ink)" }}>3 Diff</span>
    </div>
  );
}

function Picture({ id, marker }: { id: Exclude<PaneBarMode, "off">; marker: PaneMarker }) {
  return (
    <div className="agx-pbp relative overflow-hidden rounded-md" style={{ height: 96, background: "var(--bg)", border: EDGE }} aria-hidden>
      {LINES.map((w, i) => <span key={i} className="absolute rounded-sm" style={{ left: 8, top: 8 + i * 9, width: `${w}%`, height: 4, background: "var(--bg3)" }} />)}
      <span className="absolute t-mono" style={{ left: 8, bottom: id === "always" ? 26 : 5, fontSize: 5.5, color: "var(--text4)", whiteSpace: "nowrap" }}>{STATUS}</span>
      {id === "edge" && (<>
        {marker === "arrow"
          ? <span className="absolute grid place-items-center" style={{ left: "50%", bottom: 0, width: 26, height: 9, marginLeft: -13, borderRadius: "5px 5px 0 0", color: "var(--accent, var(--primary))", background: "color-mix(in srgb, var(--accent, var(--primary)) 16%, var(--surface-card))", border: EDGE, borderBottom: 0, fontSize: 6, lineHeight: 1 }}>⌃</span>
          : <span className="agx-pbp-seam absolute" style={{ left: 6, right: 6, bottom: 0, height: 3, borderRadius: 2, background: "linear-gradient(90deg, transparent, var(--accent, var(--primary)), transparent)" }} />}
        <span className="agx-pbp-slide absolute" style={{ left: 6, right: 6, bottom: 6 }}><MiniChip /></span>
      </>)}
      {id === "summary" && (<>
        <span className="agx-pbp-pill absolute flex items-center gap-1 rounded t-mono" style={{ fontSize: 6, right: 4, bottom: 4, height: 12, padding: "0 4px", background: "color-mix(in srgb, var(--bg) 90%, var(--bg3))", border: EDGE, color: "var(--text2)" }}>
          <span className="rounded-sm" style={{ width: 7, height: 7, background: "color-mix(in srgb, var(--accent, var(--primary)) 18%, transparent)" }} />retry…ery <span style={{ color: "var(--success-ink)" }}>● #318</span> <span style={{ color: "var(--warning-ink)" }}>±3</span>
        </span>
        <span className="agx-pbp-grow absolute" style={{ right: 5, bottom: 5, width: "88%" }}><MiniChip /></span>
      </>)}
      {id === "always" && (
        <span className="absolute" style={{ left: 0, right: 0, bottom: 0, height: 20, background: "color-mix(in srgb, var(--surface-card) 55%, var(--bg))", borderTop: LINE, padding: "4px 6px" }}><MiniChip /></span>
      )}
    </div>
  );
}

const CARDS: { id: Exclude<PaneBarMode, "off">; title: string; hint: string; tag?: string }[] = [
  { id: "edge", title: "Edge line", hint: "A thin line at the foot of each pane. Hover it to open the bar. Least in the way." },
  { id: "summary", title: "Summary", tag: "Recommended", hint: "Branch, pull request and changes in one small pill at the bottom right. Hover it for the rest. Uses no terminal lines." },
  { id: "always", title: "Always open", hint: "The whole bar under every pane, all the time. Uses two terminal lines." },
];

export function PaneBarPicker({ value, marker, onPick, onMarker }: {
  value: PaneBarMode; marker: PaneMarker; onPick: (m: PaneBarMode) => void; onMarker: (m: PaneMarker) => void;
}) {
  return (
    <div className="grid gap-3">
      <style>{`
        .agx-pbp-slide,.agx-pbp-grow{transform:translateY(120%);opacity:0;transition:transform .22s cubic-bezier(.23,1,.32,1),opacity .18s ease}
        .agx-pbp-card:hover .agx-pbp-slide,.agx-pbp-card:hover .agx-pbp-grow,.agx-pbp-card:focus-visible .agx-pbp-slide,.agx-pbp-card:focus-visible .agx-pbp-grow{transform:none;opacity:1}
        .agx-pbp-card:hover .agx-pbp-seam,.agx-pbp-card:hover .agx-pbp-pill{opacity:0}
        @media (prefers-reduced-motion:reduce){.agx-pbp-slide,.agx-pbp-grow{transition:none}}
      `}</style>
      <div role="radiogroup" aria-label="Pane bar" className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        {CARDS.map((c) => {
          const on = value === c.id;
          return (
            <div key={c.id} role="radio" aria-checked={on} tabIndex={0}
              onClick={() => onPick(c.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(c.id); } }}
              className="agx-pbp-card rounded-xl p-2.5 cursor-pointer"
              style={{ border: on ? "1px solid var(--accent, var(--primary))" : LINE, boxShadow: on ? "0 0 0 3px color-mix(in srgb, var(--accent, var(--primary)) 16%, transparent)" : undefined, background: "var(--bg)" }}>
              <Picture id={c.id} marker={marker} />
              <div className="mt-2.5 flex items-center gap-2 text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>
                <span className="shrink-0 rounded-full" style={{ width: 14, height: 14, border: on ? "4.5px solid var(--accent, var(--primary))" : "1.5px solid var(--border2)" }} />
                {c.title}
                {c.tag && <span className="t-mono rounded px-1 py-0.5 text-[9px]" style={{ color: "var(--success-ink)", background: "color-mix(in srgb, var(--success) 13%, transparent)" }}>{c.tag.toUpperCase()}</span>}
              </div>
              <p className="mt-1 ml-6 text-[12px] leading-snug" style={{ color: "var(--text3)" }}>{c.hint}</p>
              {c.id === "edge" && on && (
                <div className="mt-2 ml-6 flex items-center gap-2 text-[11px] t-mono" style={{ color: "var(--text3)" }} onClick={(e) => e.stopPropagation()}>
                  Marker
                  <span role="radiogroup" aria-label="Edge line marker" className="inline-flex overflow-hidden rounded-md" style={{ border: "1px solid var(--border2)" }}>
                    {(["line", "arrow"] as const).map((m, i) => (
                      <button key={m} role="radio" aria-checked={marker === m} onClick={() => onMarker(m)}
                        className="px-2 py-0.5" style={{ borderLeft: i ? "1px solid var(--border2)" : undefined, background: marker === m ? "var(--accent, var(--primary))" : "var(--bg)", color: marker === m ? "var(--bg)" : "var(--text2)" }}>
                        {m === "line" ? "Line" : "Arrow"}
                      </button>
                    ))}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <label className="flex items-center gap-2 text-[12.5px] cursor-pointer" style={{ color: "var(--text2)" }}>
        <input type="radio" name="pane-bar-off" checked={value === "off"} onChange={() => onPick("off")} />
        Off — no bar under panes
      </label>
      <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: "var(--surface-inset)", color: "var(--text3)" }}>
        Whatever you pick: <kbd>Ctrl+Shift+B</kbd> reaches the bar from the terminal (the shell keeps Tab), <kbd>←</kbd> <kbd>→</kbd> walk it, <kbd>Enter</kbd> presses, <kbd>Esc</kbd> goes back to the terminal.
      </div>
    </div>
  );
}
