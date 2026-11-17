/*
 * The Assign popover a board card's face opens: "Assign", then you (with your name), the teammates, Unassigned last,
 * each with the digit that picks it. The write is the host's (JiraMenuHost.tsx); this draws the rows and takes the keys.
 */
import { useEffect, useRef } from "react";
import { ContextMenu } from "../../../ContextMenu.tsx";
import { DoneIcon } from "../../../../lib/glyphIcons.tsx";
import { ICON } from "../../../../lib/iconSize.ts";
import { MENU_WIDTH } from "./JiraMenu.tsx";
import type { Act } from "./cardActions.ts";

export function JiraAssignPop({ rows, x, y, onPick, onClose }: { rows: readonly Act[]; x: number; y: number; onPick: (id: string) => void; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled])')?.focus(); }, []);
  const go = (a: Act) => { if (a.why) return; onPick(a.id); onClose(); };
  const onKey = (e: React.KeyboardEvent) => {
    const a = rows.find((r) => r.key === e.key && !r.why);
    if (a) { e.preventDefault(); e.stopPropagation(); go(a); }
  };
  return (
    <ContextMenu pop x={x} y={y} onClose={onClose} width={MENU_WIDTH - 40} label="Assign">
      <div ref={root} onKeyDown={onKey} className="agx-pcm">
        <div className="agx-pcm-head">Assign</div>
        <div className="agx-pcm-scroll">
          {rows.map((a) => (
            <button key={a.id} type="button" role="menuitem" tabIndex={-1} aria-disabled={a.why ? true : undefined} aria-checked={a.chk ? true : undefined} className="agx-pcm-item" onClick={() => go(a)}>
              <span aria-hidden className="agx-pcm-ico">{a.chk ? <DoneIcon size={ICON.sm} /> : null}</span>
              <span className="agx-pcm-txt"><span className="agx-pcm-lbl">{a.label}</span>{a.why && <span className="agx-pcm-sub">{a.why}</span>}</span>
              {a.key && <span aria-hidden className="agx-pcm-key">{a.key}</span>}
            </button>
          ))}
        </div>
      </div>
    </ContextMenu>
  );
}
