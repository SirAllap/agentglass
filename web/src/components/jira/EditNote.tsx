/*
 * The line a change to a Jira card leaves behind: what it did, from what to
 * what, with Undo where the site lets the old value go back, or why it was
 * refused. It stays until the next change or until it is closed, and sits in
 * one place so the controls around it never move.
 *
 * `lines` is how many lines the sentence may take before it is cut: one under
 * the card's header, two for the work log, whose sentence names two estimates.
 * `flush` drops the side padding where the note already sits inside a padded box.
 */
import { CloseButton } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { EDGE } from "../workspace/Chrome.tsx";

export function EditNote({ note, busy, onUndo, onClose, lines = 1, flush }: {
  note: { text: string; warn?: boolean; undo?: unknown } | null; busy: boolean; onUndo: () => void; onClose: () => void; lines?: 1 | 2; flush?: boolean;
}) {
  if (!note) return null;
  return (
    <div className={`${flush ? "" : "px-4 "}pb-2 flex ${lines === 1 ? "items-center" : "items-start"} gap-2 text-[10.5px] min-w-0`} role={note.warn ? "alert" : "status"}
      style={{ color: note.warn ? "var(--warning-ink)" : "var(--success-ink)" }}>
      <span className={`min-w-0 ${lines === 1 ? "truncate" : "line-clamp-2"}`} title={note.text}>{note.text}</span>
      {note.undo != null && (
        <button className="agx-btn shrink-0 rounded-md px-1.5 py-0.5" disabled={busy} onClick={onUndo}
          style={{ color: "var(--text2)", border: EDGE }} title="Put the old value back">Undo</button>
      )}
      <CloseButton size={ICON.xs} onClick={onClose} title="Dismiss" />
    </div>
  );
}
