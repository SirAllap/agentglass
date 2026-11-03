import { useRef, useState, type ReactNode } from "react";
import { AnchoredMenu } from "../AnchoredMenu.tsx";
import { CaretIcon, TagIcon, BranchIcon, CommitIcon, SearchIcon } from "../../lib/glyphIcons.tsx";
import { ICON, HIT } from "../../lib/iconSize.ts";
import { EDGE } from "../workspace/Chrome.tsx";
import type { RangeRow } from "../../lib/insightsModel.ts";

export interface Section { title: string; rows: RangeRow[]; note?: string }

const glyph = (k: RangeRow["kind"]) => k === "tag" ? <TagIcon size={ICON.sm} /> : k === "first" || k === "ref" ? <CommitIcon size={ICON.sm} /> : <BranchIcon size={ICON.sm} />;

/** A ref button that opens a searchable list. The caller decides what the rows are for each query. */
export function RangePicker({ label, shown, icon, value, sections, onPick }: {
  label: string; shown: string; icon: "tag" | "branch"; value: string;
  sections: (query: string) => Section[];
  onPick: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const anchor = useRef<HTMLSpanElement>(null);
  const secs = sections(q);
  const pick = (v: string) => { setOpen(false); setQ(""); onPick(v); };
  const any = secs.some((s) => s.rows.length);
  const body: ReactNode = (
    <div style={{ width: 290 }}>
      <label className="flex items-center gap-1.5 px-2 mb-1.5 rounded-md" style={{ height: HIT + 2, border: EDGE, background: "var(--surface-inset)" }}>
        <SearchIcon size={ICON.sm} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="a tag, branch or commit" aria-label={`${label} ref`}
          className="min-w-0 flex-1 bg-transparent outline-none text-[12px]" style={{ color: "var(--text)" }}
          onKeyDown={(e) => { if (e.key === "Enter") { const first = secs.flatMap((s) => s.rows)[0]; if (first) { e.preventDefault(); pick(first.value); } } }} />
      </label>
      {secs.map((s) => s.rows.length > 0 && (
        <div key={s.title}>
          <div className="px-2 pt-1.5 pb-1 text-[10.5px] font-medium flex gap-1.5" style={{ color: "var(--text3)" }}>{s.title}{s.note && <span className="tabular-nums">{s.note}</span>}</div>
          {s.rows.map((r) => (
            <button key={r.kind + r.value} role="menuitem" type="button" onClick={() => pick(r.value)} aria-current={r.value === value ? "true" : undefined}
              className="w-full flex items-center gap-2 px-2 rounded-md text-left text-[12px] hover:bg-[var(--surface-inset)]"
              style={{ height: HIT + 2, color: "var(--text)", background: r.value === value ? "color-mix(in srgb, var(--primary) 14%, transparent)" : undefined }}>
              <span className="shrink-0" style={{ color: "var(--text3)" }}>{glyph(r.kind)}</span>
              <span className="min-w-0 flex-1 truncate font-mono">{r.label}{r.age && <span style={{ color: "var(--text3)" }}> · {r.age}</span>}</span>
              {r.count != null && <span className="shrink-0 tabular-nums text-[11px] font-mono" style={{ color: "var(--text3)" }}>{r.count === 0 ? "0 changes" : r.count}</span>}
            </button>
          ))}
        </div>
      ))}
      {!any && <div className="px-2 py-2 text-[11.5px]" style={{ color: "var(--text3)" }}>Nothing matches.</div>}
    </div>
  );
  return (
    <span ref={anchor} className={label === "To" ? "inline-flex shrink-0" : "inline-flex min-w-0"}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`${label}: ${shown}`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 px-2 rounded-lg text-[12px] font-mono max-w-[9.5rem] min-w-0"
        style={{ height: HIT, border: EDGE, color: "var(--text)", background: open ? "var(--surface-inset)" : "var(--surface-card)" }}>
        <span className="shrink-0" style={{ color: "var(--text3)" }}>{icon === "tag" ? <TagIcon size={ICON.sm} /> : <BranchIcon size={ICON.sm} />}</span>
        <span className="min-w-0 truncate">{shown}</span><CaretIcon />
      </button>
      {open && <AnchoredMenu anchor={anchor} align="left" minWidth={306} focus="input" placeKey={`${q}:${any}`} onClose={() => { setOpen(false); setQ(""); }}>{body}</AnchoredMenu>}
    </span>
  );
}
