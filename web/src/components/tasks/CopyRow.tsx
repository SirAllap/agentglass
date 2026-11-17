import { useEffect, useState } from "react";
import { CopyIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { EDGE } from "../workspace/Chrome.tsx";

/**
 * One line of the GitHub panel: a label, a value, and a way to take it.
 *
 * ClickUp's own is a boxed field with a copy button on its right, and the value
 * is what you came for — so the whole row is the button. The label is above it
 * in small type, because a branch name is long and a label beside it would push
 * it off the row.
 */
export function CopyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      onClick={() => { void navigator.clipboard.writeText(value).then(() => setDone(true)).catch(() => setDone(false)); }}
      title={`Copy: ${value}`}
      className="agx-btn w-full text-left rounded-md px-2 py-1.5 flex items-start gap-2"
      style={{ border: EDGE, background: "color-mix(in srgb, var(--text) 3%, transparent)" }}>
      <span className="min-w-0 flex-1">
        <span className="block text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>{label}</span>
        <span className={`block text-[11px] break-all ${mono ? "font-mono" : ""}`} style={{ color: "var(--text2)" }}>{value}</span>
      </span>
      <span className="shrink-0 text-[10px] mt-2" style={{ color: done ? "var(--success)" : "var(--text4)" }}>
        {done ? "Copied" : <CopyIcon size={ICON.xs} />}
      </span>
    </button>
  );
}
