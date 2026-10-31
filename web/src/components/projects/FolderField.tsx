// A folder path with completions: the one text control that takes a path (add a
// folder, clone into, create in).
//
// Every keystroke is a directory read on the server, so it is debounced, and
// the stale-response guard matters more than the delay: a slow read of a big
// directory must not overwrite the newer answer for what has been typed since.
import { useEffect, useRef, useState } from "react";
import type { FsEntry } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { ICON } from "../../lib/iconSize.ts";
import { isAbsoluteLike } from "../../lib/projectsPaths.ts";
import { BranchIcon, FolderIcon } from "../../lib/glyphIcons.tsx";
import { INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { HAIR, HUE, ring, wash, type Hue } from "./ui.tsx";

export function FolderField({ value, onChange, onSubmit, placeholder, autoFocus, tone, trailing, label, describedBy }: {
  value: string; onChange: (v: string) => void; onSubmit?: () => void; placeholder: string; autoFocus?: boolean;
  /** The field's verdict: its edge goes green or red, not only the text under it. */
  tone?: Extract<Hue, "success" | "error">;
  trailing?: React.ReactNode; label: string; describedBy?: string;
}) {
  const [sugg, setSugg] = useState<FsEntry[]>([]);
  const [more, setMore] = useState(false);
  // -1 until the user arrows into the list: until then Enter means "take what I
  // typed", which is what someone pasting a full path expects.
  const [sel, setSel] = useState(-1);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const p = value.trim();
    if (!isAbsoluteLike(p) && !p.startsWith("~")) { setSugg([]); setMore(false); return; }
    let live = true;
    const t = setTimeout(() => {
      api.fsComplete(p)
        .then((r) => { if (live) { setSugg(r.entries); setMore(r.truncated); } })
        .catch(() => { if (live) { setSugg([]); setMore(false); } });
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [value]);

  // A new set of candidates invalidates whatever row was highlighted.
  useEffect(() => { setSel(-1); }, [sugg]);

  /** Replace the half-typed segment and leave a trailing slash, so the next
   *  completion lists inside the folder just chosen. Tab-Tab-Tab walks a tree. */
  const accept = (e: FsEntry) => { onChange(e.path + "/"); setSel(-1); ref.current?.focus(); };

  const onKey = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Tab" && sugg.length) { ev.preventDefault(); accept(sugg[sel >= 0 ? sel : 0]!); return; }
    if (ev.key === "ArrowDown" && sugg.length) { ev.preventDefault(); setSel((s) => (s + 1) % sugg.length); return; }
    if (ev.key === "ArrowUp" && sugg.length) { ev.preventDefault(); setSel((s) => (s <= 0 ? sugg.length : s) - 1); return; }
    if (ev.key === "Escape" && sugg.length) {
      // Dismiss the list without leaving the pane — a path half-typed is not thrown away.
      ev.stopPropagation(); ev.nativeEvent.stopImmediatePropagation(); setSugg([]); return;
    }
    if (ev.key === "Enter") {
      if (sel >= 0 && sugg[sel]) { accept(sugg[sel]!); return; }
      onSubmit?.();
    }
  };

  const edge = tone ? { borderColor: HUE[tone], boxShadow: `0 0 0 3px ${wash(HUE[tone], 10)}`, "--primary": HUE[tone] } as React.CSSProperties : null;
  return (
    <div className="min-w-0">
      <div className="relative flex items-center">
        <input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} aria-label={label} aria-describedby={describedBy}
          aria-invalid={tone === "error"} data-suggestions={sugg.length ? "1" : undefined} placeholder={placeholder} spellCheck={false} autoComplete="off" autoFocus={autoFocus}
          className={`w-full font-mono ${INPUT}`} style={{ ...INPUT_STYLE, ...edge, paddingRight: trailing ? 34 : undefined }} />
        {trailing && <span className="absolute right-2.5 inline-flex">{trailing}</span>}
      </div>
      {!!sugg.length && (
        <div className="agx-scroll mt-2 rounded-xl overflow-y-auto" style={{ maxHeight: 176, border: HAIR }} role="listbox" aria-label="Folders that match">
          {sugg.map((e, i) => (
            // onMouseDown, not onClick: a click first blurs the input, and
            // blur-driven dismissal would unmount the row before the click landed.
            <div key={e.path} role="option" aria-selected={i === sel} onMouseDown={(ev) => { ev.preventDefault(); accept(e); }} onMouseEnter={() => setSel(i)}
              className="px-3 py-1.5 flex items-center gap-2.5 cursor-pointer text-[12px]"
              style={{ background: i === sel ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "transparent", color: "var(--text)" }}>
              <span className="flex" style={{ color: "var(--text3)" }}>{e.repo ? <BranchIcon size={ICON.sm} /> : <FolderIcon size={ICON.sm} />}</span>
              <span className="truncate font-semibold min-w-0 flex-1" title={e.path}>{e.name}</span>
              {e.repo && <span className="shrink-0 text-[10px] px-1.5 rounded-full" style={{ color: "var(--primary-hover)", background: wash("var(--primary)", 15), boxShadow: ring("var(--primary)", 20) }}>git</span>}
            </div>
          ))}
          {more && <div className="px-3 py-1.5 text-[11px]" style={{ color: "var(--text3)" }}>More matches — keep typing</div>}
        </div>
      )}
    </div>
  );
}
