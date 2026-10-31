/*
 * What the rail's "+" opens: a short list of the site's projects, each marked
 * Added or one press from added, and "Paste an address" for everything else
 * (boards, filters, searches), which is the dialog.
 */
import { useEffect, useState, type RefObject } from "react";
import { AnchoredMenu } from "../AnchoredMenu.tsx";
import { FilterField } from "../workspace/Chrome.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { DoneIcon, LinkIcon } from "../../lib/glyphIcons.tsx";
import { useJiraTree } from "../../lib/useJiraTree.ts";
import { toneOf } from "../../lib/jiraTree.ts";

export const POPOVER_WAIT_MS = 300;

export function AddSpacePopover({ anchor, onPaste, onClose }: { anchor: RefObject<HTMLElement | null>; onPaste: () => void; onClose: () => void }) {
  const tree = useJiraTree(true);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => { void tree.loadPicker(/^[A-Za-z][A-Za-z0-9_]{1,31}$/.test(q.trim()) ? q.trim().toUpperCase() : ""); }, q ? POPOVER_WAIT_MS : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const needle = q.trim().toLowerCase();
  const rows = tree.picker.projects.filter((p) => !needle || p.key.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle));
  const add = async (key: string) => {
    if (busy) return;
    setBusy(key); setErr(null);
    const r = await tree.edit({ add: key });
    setBusy(null);
    if (!r.ok) { setErr(r.error || "Could not add that"); return; }
    tree.select({ kind: "space", space: key });
    tree.toggle(`s:${key}`, true);
    onClose();
  };
  return (
    <AnchoredMenu anchor={anchor} align="left" minWidth={272} focus="input" keepTab placeKey={rows.length} onClose={onClose}>
      <div className="flex flex-col" style={{ gap: 2, width: 272 }}>
        <FilterField value={q} onChange={setQ} label="Find a project" placeholder="Find a project" />
        <div className="px-2 pt-2 pb-1 text-[10.5px] uppercase" style={{ letterSpacing: "0.04em", color: "var(--text4)" }}>Projects</div>
        {tree.picker.state === "error" && <div role="alert" className="px-2 py-1 text-[11px]" style={{ color: "var(--error-ink)" }}>{tree.picker.error}</div>}
        {err && <div role="alert" className="px-2 py-1 text-[11px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
        {tree.picker.state !== "ready" && tree.picker.state !== "error" && !rows.length && <div className="px-2 py-1 text-[11px]" style={{ color: "var(--text3)" }}>Asking Jira…</div>}
        {tree.picker.state === "ready" && !rows.length && <div className="px-2 py-1 text-[11px]" style={{ color: "var(--text3)" }}>No project matches.</div>}
        {rows.map((p) => (
          <button key={p.key} role="menuitem" aria-disabled={p.added || undefined} disabled={busy === p.key}
            onClick={() => { if (!p.added) void add(p.key); }}
            className="agx-rail-row flex items-center text-left" style={{ height: 28, gap: 8, padding: "0 8px", borderRadius: 8, fontSize: 12, color: p.added ? "var(--text3)" : "var(--text2)", cursor: p.added ? "default" : "pointer" }}>
            <span aria-hidden className="shrink-0 grid place-items-center" style={{ width: 20, height: 20, borderRadius: 6, color: toneOf(p.key), background: `color-mix(in srgb, ${toneOf(p.key)} 14%, transparent)`, font: "700 9.5px/1 var(--font-mono, monospace)" }}>{p.key[0]}</span>
            <span className="truncate min-w-0">{p.name}</span>
            <span className="tabular-nums shrink-0" style={{ fontSize: 10.5, color: "var(--text4)" }}>{p.key}</span>
            <span className="flex-1" />
            {p.added
              ? <span className="inline-flex items-center shrink-0" style={{ gap: 4, fontSize: 10.5, color: "var(--success-ink, var(--success))" }}><DoneIcon size={ICON.xs} />Added</span>
              : <span className="shrink-0" style={{ fontSize: 10.5, color: "var(--text2)" }}>Add</span>}
          </button>
        ))}
        <div role="separator" style={{ height: 1, margin: "4px 2px", background: "var(--surface-line)" }} />
        <button role="menuitem" onClick={() => { onClose(); onPaste(); }} className="agx-rail-row flex items-center text-left" style={{ height: 28, gap: 8, padding: "0 8px", borderRadius: 8, fontSize: 12, color: "var(--text2)" }}>
          <LinkIcon size={ICON.sm} />Paste an address
        </button>
      </div>
    </AnchoredMenu>
  );
}
