/*
 * An agent asks to clean up a merged PR's local leftovers: the dry-run summary
 * and the person's one click. The same card is drawn in the corner (the settings
 * requests) and in the Lantern's Waiting section, so the two cannot say different
 * things; each passes how an answer is sent. Every word that names something is
 * the server's (the plan it computed), never what the agent wrote.
 */
import { useState, type ReactElement } from "react";
import type { CardRequest, CleanupCardView } from "../lib/cleanupCard.ts";
import { ICON } from "../lib/iconSize.ts";
import { FileIcon, LockIcon, DoneIcon } from "../lib/glyphIcons.tsx";
import { ChevronRightIcon, GroupIcon, ShieldIcon } from "./settingsNavIcons.tsx";
import { KIND_ICON } from "./CleanupSettings.tsx";
import { CLEANUP_KIND_ROWS } from "../lib/cleanupSettings.ts";
import "./cleanupSettings.css";
import "./cleanupAsk.css";

const ICON_OF = new Map(CLEANUP_KIND_ROWS.map((k) => [k.id as string, KIND_ICON[k.icon]]));
const NOTE_ICON = { patch: FileIcon, shield: ShieldIcon, lock: LockIcon } as const;
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function CleanupAskCard({ r, view, busy, error, onAnswer, corner }: {
  r: CardRequest; view: CleanupCardView; busy: boolean; error: string | null; onAnswer: (approve: boolean) => void;
  /** In the corner column (360 px, shared with other chips) the card is drawn at its own width and overflows the column to the right; in the Lantern it fills its column. */
  corner?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="agx-ca" data-corner={corner ? "" : undefined} data-settings-request={r.setting} role="alertdialog" aria-label={view.headline}>
      <div className="agx-ca-head">
        <span className="agx-ca-tile"><GroupIcon name="bot" size={ICON.md} /></span>
        <div><b>{view.headline}</b><span>{view.sub}</span></div>
      </div>
      <div className="agx-ca-body">
        <div className="agx-ca-hero">
          <div className="agx-ca-big"><b>{view.size}</b><span>{view.count}</span></div>
          <div className="agx-ca-bar" role="img" aria-label="Size by kind">
            {view.bar.map((b) => <i key={b.group} data-cl-kind={b.group} title={`${b.name} ${b.size}`} style={{ flex: b.flex }} />)}
          </div>
        </div>
        <div className="agx-ca-chips">
          {view.chips.map((c) => {
            const Ic = ICON_OF.get(c.group);
            return <span key={c.group} className="agx-ca-chip" data-cl-kind={c.group}>{Ic && <Ic size={ICON.sm} />}{c.name} <em>{c.text}</em></span>;
          })}
        </div>
        {view.notes.map((n) => { const Ic = NOTE_ICON[n.icon]; return <div key={n.icon} className="agx-ca-line"><Ic size={ICON.sm} /><span>{n.text}</span></div>; })}
        <button type="button" className="agx-ca-disc" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="agx-ca-chev" data-open={open}><ChevronRightIcon size={ICON.xs} /></span>{open ? "Hide the full list" : "Show the full list"}
        </button>
        {open && (
          <div className="agx-ca-list">
            {view.full.map((g) => (
              <div key={g.group}>
                <div className="agx-ca-gname">{g.name}</div>
                {g.rows.map((i) => <div key={`${i.kind}:${i.target}`} className="agx-ca-item" title={i.target}><span>{i.target}</span></div>)}
              </div>
            ))}
            {view.unlisted > 0 && <div className="agx-ca-more">and {view.unlisted} more not listed here</div>}
          </div>
        )}
        {error && <div role="alert" className="agx-ca-error">{error}</div>}
      </div>
      <div className="agx-ca-foot">
        <span>{r.expires ? `Declined by itself at ${clock(r.expires)} if you do not answer.` : "Waits here until you answer."}</span>
        <button type="button" className="agx-ca-btn" disabled={busy} onClick={() => onAnswer(false)}>Decline</button>
        <button type="button" className="agx-ca-btn primary" disabled={busy} onClick={() => onAnswer(true)}><DoneIcon size={ICON.sm} />Approve and clean</button>
      </div>
    </div>
  );
}

