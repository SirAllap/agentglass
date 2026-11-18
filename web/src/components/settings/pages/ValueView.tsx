import { useState } from "react";
import { CaretIcon, CopyIcon, DoneIcon, RefreshIcon } from "../../../lib/glyphIcons.tsx";
import { Badge, LINE } from "../../workspace/Chrome.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { enumLabel, flagsTable, keyCount, valueKind, LONG_AT } from "./valueKind.ts";

const PILL = "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium";
const PILL_STYLE = { background: "var(--bg3)", color: "var(--text)", border: LINE } as const;
const MUTED = { color: "var(--text2)" } as const;


function Tree({ v }: { v: unknown }) {
  if (v && typeof v === "object") {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
    return (
      <div className="flex flex-col gap-1 pl-3 font-mono text-[11px]" style={{ borderLeft: LINE }}>
        {entries.map(([k, x]) => (
          <div key={k} className="flex gap-2 items-baseline">
            <span style={MUTED}>{k}</span>
            {x && typeof x === "object" ? <div className="flex-1"><Tree v={x} /></div> : <span className="[overflow-wrap:anywhere]">{String(x)}</span>}
          </div>
        ))}
      </div>
    );
  }
  return <span className="font-mono text-[11px]">{String(v)}</span>;
}

/** A stored value drawn by its kind: Yes/No pill, label pill, chips, collapsed key tree, muted "Not set", truncated mono string. */
export function ValueView({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  const kind = valueKind(value);
  if (kind === "empty") return <span className="text-[12px]" style={MUTED}>Not set</span>;
  if (kind === "boolean") return <span className={PILL} style={PILL_STYLE}>{value ? "Yes" : "No"}</span>;
  if (kind === "enum") return <span className={PILL} style={PILL_STYLE}>{enumLabel(value)}</span>;
  if (kind === "list") return <div className="flex flex-wrap gap-1 justify-end">{(value as string[]).map((x, i) => <Badge key={`${i}-${x}`} tint="var(--text)" outlined clip>{x}</Badge>)}</div>;
  if (kind === "object" || kind === "long") {
    const text = String(value);
    return (
      <div className="flex flex-col items-end gap-1 max-w-full">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-[12px]" style={kind === "object" ? { color: "var(--accent)" } : { color: "var(--text)" }}>
          <CaretIcon className={open ? "rotate-90" : ""} />
          {kind === "object" ? keyCount(value) : <span className="font-mono truncate max-w-[280px]">{text.slice(0, LONG_AT)}…</span>}
        </button>
        {open && (kind === "object" ? <Tree v={value} /> : <div className="font-mono text-[11px] [overflow-wrap:anywhere] text-left">{text}</div>)}
      </div>
    );
  }
  return <span className="font-mono text-[12px] [overflow-wrap:anywhere]">{String(value)}</span>;
}

/** House copy icon; the app's tooltip (data-tip, never title); "Copied" for 1.5 s. */
export function CopyButton({ label, text, onCopy }: { label: string; text: string; onCopy: (t: string) => void }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" aria-label={`Copy ${label}`} data-tip={done ? "Copied" : "Copy"}
      onClick={() => { onCopy(text); setDone(true); setTimeout(() => setDone(false), 1500); }}
      className="inline-flex items-center gap-1 text-[11px] shrink-0" style={MUTED}>
      {done ? <><DoneIcon />Copied</> : <CopyIcon />}
    </button>
  );
}

/** The launch flags of every engine as one table: engines down, permission modes across. */
export function FlagsTable({ rows }: { rows: { engine: string; value: unknown }[] }) {
  const t = flagsTable(rows);
  return (
    <div className="overflow-x-auto px-3 py-2.5" style={{ borderTop: LINE }}>
      <table className="w-full text-[12px] border-collapse">
        <thead>
          <tr>
            <th scope="col" className="text-left font-semibold pb-1.5 pr-3">Launch flags</th>
            {t.modes.map((m) => <th key={m.id} scope="col" className="text-left font-semibold pb-1.5 pr-3">{m.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r) => (
            <tr key={r.engine} style={{ borderTop: LINE }}>
              <th scope="row" className="text-left font-medium py-1.5 pr-3 align-top whitespace-nowrap">{r.engine}</th>
              {r.cells.map((c, i) => (
                <td key={t.modes[i]!.id} className="py-1.5 pr-3 align-top">
                  {c.length ? <div className="flex flex-wrap gap-1">{c.map((f, j) => <Badge key={`${j}-${f}`} tint="var(--text)" outlined clip>{f}</Badge>)}</div> : <span style={MUTED}>—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TAG = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 mt-1 mr-1 text-[11px] font-medium";
const TAG_STYLE = { background: "var(--bg3)", color: "var(--text2)" } as const;

/** Under a row's label: the reason to touch it (When: …) and, for a start-time setting, the restart note. Its own style, not help text. */
export function TouchTags({ when, restart }: { when: string | null; restart?: boolean }) {
  if (!when && !restart) return null;
  return (
    <div className="flex flex-wrap">
      {when && <span data-when-tag className={TAG} style={TAG_STYLE}>When: {when}</span>}
      {restart && <span data-restart-tag className={TAG} style={TAG_STYLE}><RefreshIcon size={ICON.xs} />Takes effect after a restart</span>}
    </div>
  );
}
