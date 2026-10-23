/*
 * The line a change to a Jira card leaves behind: what it did, from what to
 * what, with Undo where the site lets the old value go back, or why it was
 * refused. It stays until the next change or until it is closed, and sits in
 * one place under the card's header so the controls above it never move.
 */
import { CloseButton } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { EDGE } from "../workspace/Chrome.tsx";
import type { EditNote as Note } from "./useJiraEdit.ts";

export function EditNote({ note, busy, onUndo, onClose }: { note: Note | null; busy: boolean; onUndo: () => void; onClose: () => void }) {
  if (!note) return null;
  return (
    <div className="px-4 pb-2 flex items-center gap-2 text-[10.5px] min-w-0" role={note.warn ? "alert" : "status"}
      style={{ color: note.warn ? "var(--warning-ink)" : "var(--success-ink)" }}>
      <span className="min-w-0 truncate" title={note.text}>{note.text}</span>
      {note.undo && (
        <button className="agx-btn shrink-0 rounded-md px-1.5 py-0.5" disabled={busy} onClick={onUndo}
          style={{ color: "var(--text2)", border: EDGE }} title="Put the old value back">Undo</button>
      )}
      <CloseButton size={ICON.xs} onClick={onClose} title="Dismiss" />
    </div>
  );
}
