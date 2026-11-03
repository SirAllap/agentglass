import { useEffect, useRef } from "react";
import { CloseIcon } from "../../CloseButton.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import type { FooterNote } from "../../../lib/tasksFooterNote.ts";
import type { JiraListModel } from "./model.ts";
import { footerCount, readStamp } from "./toolbarModel.ts";
import { LINE } from "../../workspace/Chrome.tsx";

/** The footer, 32 high: how many of the page are shown, how old the read is, and which view it is. A note (a copy, a write) takes the place of the count while it lasts. */
export interface JiraFooterProps {
  model: JiraListModel;
  note?: FooterNote | null;
  onCloseNote?: () => void;
}

export function JiraFooter({ model, note, onCloseNote }: JiraFooterProps) {
  /* The note goes on its own (6 s, a failure 12 s): the timer is the note's, started when it arrives. */
  const close = useRef(onCloseNote);
  close.current = onCloseNote;
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => close.current?.(), note.ok ? 6000 : 12000);
    return () => clearTimeout(t);
  }, [note?.ok, note?.text]);

  const stale = model.read === "stale";
  const tone = note?.ok ? "var(--success-ink)" : "var(--warning-ink)";
  return (
    <div data-slot="footer" role="status" className="flex items-center shrink-0 text-[10.5px]"
      style={{ gap: 12, height: 32, padding: "0 24px", color: "var(--text4)", borderTop: LINE }}>
      {note ? (
        <>
          <span className="min-w-0 flex-1 truncate" style={{ color: tone }} data-tip={note.text}>{note.text}</span>
          {note.go && <button type="button" onClick={() => { note.go!.run(); onCloseNote?.(); }} className="agx-chip shrink-0 underline underline-offset-2" style={{ padding: "0 6px", borderRadius: 6, color: tone }}>{note.go.label}</button>}
          <button type="button" onClick={onCloseNote} aria-label="Dismiss" data-tip="Dismiss" className="agx-chip grid place-items-center shrink-0" style={{ width: 20, height: 20, borderRadius: 6, color: tone }}><CloseIcon size={ICON.xs} /></button>
        </>
      ) : (
        <>
          <span className="tabular-nums">{model.phase === "loading" ? "Reading…" : footerCount(model.counts, model.truncated)}</span>
          {!!model.at && <span style={stale ? { color: "var(--warning-ink)" } : undefined}>· {readStamp(model.at)}{stale ? " · may be out of date" : ""}</span>}
          {model.truncated && <span>· and more behind it</span>}
          <span className="flex-1" />
          {model.view?.name && <span className="truncate" style={{ maxWidth: 280 }} data-tip={model.view.name}>{model.view.name}</span>}
        </>
      )}
    </div>
  );
}
