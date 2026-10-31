import { useEffect, useRef, type ReactNode } from "react";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { LINE } from "../workspace/Chrome.tsx";
import type { FooterNote } from "../../lib/tasksFooterNote.ts";

/**
 * The line at the bottom of a source's body: its count on the left, and
 * whatever a button just answered in the same place.
 *
 * A confirmation used to be a strip under the toolbar and a pill on the row's
 * Due cell, both over something somebody was reading. The footer is the one
 * place nothing lives under. The note takes the place of `children` (the count)
 * while it lasts; `end` stays.
 *
 * It goes on its own, and it can be sent away: the timer is for the nine times
 * in ten the reader has moved on, the × for the tenth. A failure is given twice
 * as long, since an error is read and a confirmation is only glanced at. The
 * timer is the note's: it starts when the note arrives and ends with it, it is
 * not a poll.
 */
export function StatusFooter({ note, onClose, children, end }: {
  note: FooterNote | null; onClose: () => void; children: ReactNode; end?: ReactNode;
}) {
  // The latest close, read when the timer fires: a caller that passes a new
  // arrow every render must not restart the note's six seconds each time.
  const close = useRef(onClose);
  close.current = onClose;
  const tone = note?.ok ? "var(--success-ink)" : "var(--warning-ink)";
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => close.current(), note.ok ? 6000 : 12000);
    return () => clearTimeout(t);
    // The text as well as the flag: two confirmations in a row are two notes,
    // and the second deserves its own six seconds.
  }, [note?.ok, note?.text]);
  return (
    <div className="flex items-center gap-3 px-5 py-1.5 shrink-0 text-[10.5px]" role="status"
      style={{ borderTop: LINE, color: "var(--text4)" }}>
      {note ? (
        <>
          <span className="min-w-0 flex-1 truncate" style={{ color: tone }} title={note.text}>{note.text}</span>
          {/* A note that names a place has to be able to take you there. */}
          {note.go && (
            <button onClick={() => { note.go!.run(); onClose(); }}
              className="shrink-0 px-1.5 rounded hover:bg-white/10 underline underline-offset-2"
              style={{ color: tone }}>{note.go.label}</button>
          )}
          <button onClick={onClose} title="Dismiss" aria-label="Dismiss"
            className="shrink-0 grid place-items-center w-5 h-5 rounded hover:bg-white/10" style={{ color: tone }}><CloseIcon size={ICON.xs} /></button>
        </>
      ) : children}
      {end}
    </div>
  );
}
