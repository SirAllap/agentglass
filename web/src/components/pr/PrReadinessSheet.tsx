import type { ReactNode } from "react";
import { Switch } from "../SettingRow.tsx";
import { LAYER } from "../../lib/layers.ts";
import { ICON } from "../../lib/iconSize.ts";
import { type Chip, type Gate, type GateTab } from "../../lib/prGates.ts";
import { ToneGlyph } from "./PrGates.tsx";
import { CrossIcon, DraftIcon, UndoIcon } from "../../lib/glyphIcons.tsx";

type Method = "squash" | "merge" | "rebase";

/**
 * What the verdict chip opens, upward from the dock: what is in the way (each
 * with a button to where it is fixed), the merge method, the commit message,
 * auto-merge, the merge lock, and the two ends of a pull request's life
 * (draft, close). Every control here calls the handler the dock already had.
 */
export function PrReadinessSheet({ chip, open, isDraft, methods, method, labelOf, onMethod, message, auto, onAuto, lock, update, tightOnly, extra, canClose, onDraft, onClose, onGo, onDismiss, busy }: {
  chip: Chip;
  open: boolean;
  isDraft: boolean;
  methods: Method[];
  method: Method;
  labelOf: (m: Method) => string;
  onMethod: (m: Method) => void;
  /** GitHub writes the commit message from the title; shown so nobody wonders. */
  message: string;
  auto: { on: boolean; disabled: boolean; title: string } | null;
  onAuto: () => void;
  /** The merge-lock button, drawn by the caller. */
  lock?: ReactNode;
  /** Update branch, when the dock does not carry it (closed pull requests). */
  update?: ReactNode;
  /** Update branch and Merge lock again, shown only while the dock is under 440px and hides them (index.css .prx-tight-only). */
  tightOnly?: ReactNode;
  /** What the dock no longer carries as buttons: resolve conflicts, the base-check and lag notes. */
  extra?: ReactNode;
  /** An open pull request can be closed or made a draft; a closed one is reopened. */
  canClose: boolean;
  onDraft: () => void;
  onClose: () => void;
  onGo: (tab: GateTab) => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  if (!open) return null;
  const closed = chip.label === "Closed";
  return (
    <div className="prx-sheet" role="group" aria-label="Merge readiness" data-pr-sheet data-tone={chip.tone} style={{ zIndex: LAYER.pane }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onDismiss(); } }}>
      <div className="h1"><span aria-hidden className="flex" style={{ color: "var(--tone)" }}><ToneGlyph tone={chip.tone} size={ICON.md} /></span>{chip.label}</div>
      {chip.blockers.length > 0 && (
        <div className="grp">
          <h5>What is in the way</h5>
          {chip.blockers.map((g: Gate) => (
            <div key={g.key} className="need" data-tone={g.tone}>
              <ToneGlyph tone={g.tone} />
              <span><b>{g.label}</b>{g.value}</span>
              <button type="button" className="agx-btn px-2 rounded-md text-[12px]" style={{ height: 26 }} onClick={() => { onDismiss(); onGo(g.tab); }}>Open</button>
            </div>
          ))}
        </div>
      )}
      {!closed && chip.label !== "Merged" && (
        <>
          <div className="grp">
            <h5>Merge method</h5>
            <div className="radio" role="radiogroup" aria-label="Merge method">
              {methods.map((m) => (
                <label key={m}><input type="radio" name="prx-method" checked={method === m} disabled={busy} onChange={() => onMethod(m)} />{labelOf(m)}</label>
              ))}
            </div>
          </div>
          <div className="grp">
            <h5>Commit message</h5>
            <textarea className="msg" rows={2} readOnly value={message} aria-label="Commit message GitHub will write" />
          </div>
          {auto && (
            <div className="grp">
              <button type="button" className="sw w-full text-left" role="switch" aria-checked={auto.on} disabled={auto.disabled} data-tip={auto.title} onClick={onAuto}>
                <span>Auto-merge once everything passes</span><Switch on={auto.on} />
              </button>
              {lock && <div className="sw"><span>Merge lock</span>{lock}</div>}
            </div>
          )}
          {(update || extra || tightOnly) && <div className="grp flex flex-wrap items-center gap-2">{update}{tightOnly && <span className="prx-tight-only items-center gap-2">{tightOnly}</span>}{extra}</div>}
        </>
      )}
      <div className="grp">
        <div className="flex gap-2 flex-wrap">
          {canClose && !closed && (
            <button type="button" className="agx-btn px-2.5 rounded-md text-[12px] inline-flex items-center gap-1.5" style={{ height: 26 }} disabled={busy} onClick={() => { onDismiss(); onDraft(); }}>
              <DraftIcon size={ICON.xs} />{isDraft ? "Mark ready for review" : "Convert to draft"}
            </button>
          )}
          {chip.label !== "Merged" && (
            <button type="button" className="agx-btn px-2.5 rounded-md text-[12px] inline-flex items-center gap-1.5" style={{ height: 26, color: closed ? undefined : "var(--error)" }} disabled={busy} onClick={() => { onDismiss(); onClose(); }}>
              {closed ? <UndoIcon size={ICON.xs} /> : <CrossIcon size={ICON.xs} />}{closed ? "Reopen pull request" : "Close pull request"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
