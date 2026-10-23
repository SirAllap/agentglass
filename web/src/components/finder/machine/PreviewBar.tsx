// The preview's header, as Strata draws it: the type icon, the name over a one-line
// "3 kB · 4m ago · text/markdown", and the tools at the right. The tools a view has
// (source, find, wrap) come from PreviewBody as `tools`; open-externally, print and
// close are the panel's own.
import type { ReactNode } from "react";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { LINE } from "../../workspace/Chrome.tsx";
import { StrataIcon } from "./StrataIcon.tsx";

/** One 28-px tool of the bar. `on` is a toggle that is currently set. */
export function BarButton({ icon, label, onClick, on, disabled }: { icon: string; label: string; onClick?: () => void; on?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className="agx-btn rounded-md grid place-items-center shrink-0 disabled:opacity-40" disabled={disabled} title={label} aria-label={label} aria-pressed={on}
      style={{ width: HIT - 4, height: HIT - 4, color: on ? "var(--primary-ink)" : "var(--text3)", background: on ? "color-mix(in srgb, var(--primary) 14%, transparent)" : undefined }} onClick={onClick}>
      <StrataIcon set="act" name={icon} size={ICON.sm} />
    </button>
  );
}

export function PreviewBar({ lead, name, meta, title, tools, afterPrint, onOpen, onPrint, onClose }: {
  lead: ReactNode; name: string; meta: string; title?: string;
  /** What this view adds before the common tools. */
  tools?: ReactNode;
  /** Strata puts the wrap switch after print. */
  afterPrint?: ReactNode;
  onOpen?: () => void; onPrint?: () => void; onClose?: () => void;
}) {
  return (
    <div className="px-3 flex items-center gap-2 shrink-0" style={{ minHeight: 44, borderBottom: LINE }}>
      <span className="shrink-0 flex">{lead}</span>
      <div className="flex-1 min-w-0">
        <h3 className="m-0 text-[13px] font-semibold truncate" title={title ?? name}>{name}</h3>
        {meta && <div className="text-[10.5px] truncate" style={{ color: "var(--text3)" }}>{meta}</div>}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {tools}
        {onOpen && <BarButton icon="external-link" label="Open in the default application" onClick={onOpen} />}
        {onPrint && <BarButton icon="printer" label="Print" onClick={onPrint} />}
        {afterPrint}
        {onClose && <BarButton icon="panel-right-close" label="Close preview (Space)" onClick={onClose} />}
      </div>
    </div>
  );
}
