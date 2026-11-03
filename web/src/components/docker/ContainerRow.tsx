/*
 * One container, one row: the state as glyph and word, the name with one
 * sub-line that says why or what, CPU and memory as meters that go amber at 50
 * and 80, the port you can open, ONE action for this state, and a "..." menu in
 * the same slot on every row. The columns are the grid in dockerCss.ts, which
 * the stack's column labels share.
 */
import type { CSSProperties } from "react";
import type { DockerContainer, DockerStat } from "../../../../shared/types.ts";
import { displayName, KINDS, kindOf, needsYou, rowAction, type RowVerb } from "../../lib/dockerState.ts";
import { meterOf, portCell, whyOf } from "../../lib/dockerView.ts";
import { ownerTitle } from "../../lib/dockerRow.ts";
import { BranchIcon, MoreIcon, PlayIcon, RefreshIcon, CrossIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button } from "../workspace/Chrome.tsx";
import { Badge, ExtIcon, Glyph } from "./Glyphs.tsx";

export function Meter({ label, v, hot, sub }: { label: string; v: number | null; hot: boolean; sub?: string }) {
  if (v == null) {
    return <div className="dk-m" data-none aria-label={`${label}: not sampled`}><div className="v"><span>—</span></div><div className="bar" /></div>;
  }
  return (
    <div className="dk-m" data-hot={hot || undefined} aria-label={`${label} ${v}%`}>
      <div className="v"><b style={{ fontWeight: 500 }}>{label === "CPU" ? v.toFixed(1) : Math.round(v)}%</b>{sub ? <small>{sub}</small> : null}</div>
      <div className="bar"><i style={{ width: `${Math.max(2, Math.min(100, v))}%` }} /></div>
    </div>
  );
}

const ICONS: Record<RowVerb, React.ReactNode> = {
  start: <PlayIcon size={ICON.xs} />, unpause: <PlayIcon size={ICON.xs} />,
  restart: <RefreshIcon size={ICON.sm} />, rm: <CrossIcon size={ICON.sm} />,
};

export function ActionButton({ c, readOnly, busy, onVerb, labelled }: {
  c: DockerContainer; readOnly: boolean; busy: boolean; onVerb: (v: RowVerb) => void;
  /** The detail header spells the verb out; a row has room for the icon only. */
  labelled?: boolean;
}) {
  const a = rowAction(kindOf(c), { readOnly });
  const icon = busy ? <span className="dk-spin" style={{ display: "flex" }}><RefreshIcon size={ICON.sm} /></span> : ICONS[a.verb];
  return (
    <button type="button" className={labelled ? "dk-chip" : "dk-act"} data-tone={labelled ? "" : undefined} style={{ "--tone": a.tone } as CSSProperties}
      data-verb={a.verb} aria-label={`${a.label} ${displayName(c)}`} title={a.reason ?? `${a.label}${a.verb === "rm" ? "…" : ""}`}
      disabled={a.disabled || busy} aria-busy={busy || undefined}
      onClick={(e) => { e.stopPropagation(); onVerb(a.verb); }}>
      {icon}{labelled && a.label}
    </button>
  );
}

export function MoreButton({ c, open, onMenu, chip }: { c: DockerContainer; open: boolean; onMenu: (el: HTMLElement) => void; chip?: boolean }) {
  return (
    <button type="button" className={chip ? "dk-chip sq" : "dk-more"} data-open={open || undefined} aria-label={`More for ${displayName(c)}`}
      aria-haspopup="menu" aria-expanded={open} title="More"
      onClick={(e) => { e.stopPropagation(); onMenu(e.currentTarget); }}>
      <MoreIcon size={ICON.sm} />
    </button>
  );
}

export function ContainerRow({ c, stat, selected, dense, readOnly, busy, confirm, menuOpen, onSelect, onVerb, onMenu, onOpenPort, onConfirm }: {
  c: DockerContainer; stat?: DockerStat; selected: boolean; dense: boolean; readOnly: boolean; busy: boolean;
  /** The verb waiting for a yes, inline under this row. */
  confirm: "stop" | "rm" | null;
  menuOpen: boolean;
  onSelect: () => void;
  onVerb: (v: RowVerb) => void;
  onMenu: (el: HTMLElement) => void;
  /** Opening a port belongs to whoever owns the browser, not to a row. */
  onOpenPort: (url: string) => void;
  onConfirm: (yes: boolean) => void;
}) {
  const kind = kindOf(c);
  const why = whyOf(c);
  const m = meterOf(stat, (c.state || "").toLowerCase() === "running");
  const port = portCell(c);
  const name = displayName(c);
  const off = kind === "stop" || kind === "made";
  const portStyle: CSSProperties = { minWidth: 0, display: "flex" };
  return (
    <>
      <div role="row" tabIndex={0} className="dk-cols dk-r" aria-label={`${name}, ${KINDS[kind].word}`}
        data-sel={selected || undefined} data-need={needsYou(c) || undefined} data-off={off || undefined} data-dense={dense || undefined}
        data-cid={selected ? "active" : undefined}
        title={[c.name, c.image, c.status, c.ports, c.owner ? ownerTitle(c.owner) : "",
          c.healthError ? `health: ${c.healthError}` : "", c.restarts ? `restarted ${c.restarts}×` : ""].filter(Boolean).join("\n")}
        onClick={onSelect}
        onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); onSelect(); } }}>
        <Glyph kind={kind} />
        <div style={{ minWidth: 0 }}>
          <div className="dk-nm">
            <span>{name}</span>
            {kind === "unhealthy" && <Badge tint="var(--error-ink, var(--error))">unhealthy</Badge>}
            {c.health === "starting" && <Badge tint="var(--warning-ink, var(--warning))">starting</Badge>}
            {kind === "restarting" && <Badge tint="var(--warning-ink, var(--warning))" title={c.restarts ? `Restarted ${c.restarts} times` : undefined}>restarting</Badge>}
            {c.owner?.foreign && (
              <Badge tint="var(--merged-ink)" title={`Started from another checkout\n${ownerTitle(c.owner)}`}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><BranchIcon size={ICON.xs} />{c.owner.worktree}</span>
              </Badge>
            )}
          </div>
          {!dense && <span className="dk-sb"><span data-tone={why.tone || undefined}>{why.text}</span></span>}
        </div>
        <Meter label="CPU" v={m.cpu} hot={m.cpuHot} />
        <Meter label="Memory" v={m.mem} hot={m.memHot} sub={m.memSub} />
        <div style={portStyle}>
          {port.kind === "web"
            ? <button type="button" className="dk-port" data-port="web" title={`${port.title} in the browser tab`} aria-label={`Open ${port.label}`}
              onClick={(e) => { e.stopPropagation(); onOpenPort(port.url!); }}><ExtIcon size={12} />{port.label}</button>
            : <span className="dk-port" data-port={port.kind} title={port.title} aria-label={port.kind === "none" ? "no port" : undefined}>{port.label}</span>}
        </div>
        <ActionButton c={c} readOnly={readOnly} busy={busy} onVerb={onVerb} />
        <MoreButton c={c} open={menuOpen} onMenu={onMenu} />
      </div>
      {confirm && (
        <div className="dk-confirm" role="alertdialog" data-danger={confirm === "rm" || undefined}>
          <span>{confirm === "rm" ? "remove" : confirm} <b>{name}</b>?{confirm === "rm" ? " It cannot be undone; its volumes stay." : ""}</span>
          <Button size="compact" tone={confirm === "rm" ? "danger" : "plain"} onClick={() => onConfirm(true)}>{confirm === "rm" ? "remove" : confirm}</Button>
          <Button size="compact" tone="quiet" onClick={() => onConfirm(false)}>Cancel</Button>
        </div>
      )}
    </>
  );
}
