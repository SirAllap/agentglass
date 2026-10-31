/*
 * The one line that closes a cleanup: "Cleaned ORBIT-1042 · 6.4 GB freed", with
 * Details unfolding what was removed. It replaces the Done screen for a run that
 * went through without a look (CleanupDialog's finished step in Ask mode, the
 * direct run at merge time). Bottom right like UpdateToast; the two share a
 * corner and a release note arriving in the same second would sit under this one,
 * which a dismiss clears.
 */
import { useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import { currentCleanupNote, showCleanupNote, subscribeCleanupNote } from "../lib/cleanupEvents.ts";
import { ICON } from "../lib/iconSize.ts";
import { DoneIcon, SparkleIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { CloseButton } from "./CloseButton.tsx";
import { EDGE } from "./workspace/Chrome.tsx";

/** A clean line goes by itself; one with problems waits for the person. */
const HOLD_MS = 10_000;

export function CleanupToast(): ReactElement | null {
  const note = useSyncExternalStore(subscribeCleanupNote, currentCleanupNote, () => null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
    if (!note || note.tone !== "ok") return;
    const t = setTimeout(() => showCleanupNote(null), HOLD_MS);
    return () => clearTimeout(t);
  }, [note]);
  if (!note) return null;
  return (
    <div className="fixed rounded-xl text-left" role="status" data-cleanup-toast="" data-tone={note.tone}
      style={{ right: 16, bottom: 16, width: 360, zIndex: 60, padding: "10px 36px 10px 12px", background: "var(--surface-card)", border: EDGE, boxShadow: "0 12px 34px #000a" }}>
      <CloseButton onClick={() => showCleanupNote(null)} title="Dismiss" hit={22} style={{ top: 8, right: 9, color: "var(--text4)" }} className="absolute rounded" />
      <div className="flex items-start gap-2 text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>
        <span style={{ color: note.tone === "warn" ? "var(--warning)" : note.tone === "run" ? "var(--text3)" : "var(--success)", marginTop: 2 }}>{note.tone === "warn" ? <WarningIcon size={ICON.sm} /> : note.tone === "run" ? <SparkleIcon size={ICON.sm} /> : <DoneIcon size={ICON.sm} />}</span>
        <span>{note.text}</span>
      </div>
      {note.lines.length > 0 && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="text-[11.5px] mt-1.5 underline" style={{ color: "var(--primary-ink)" }}>{open ? "Hide details" : "Details"}</button>
      )}
      {open && <ul className="mt-1.5 text-[11px]" style={{ color: "var(--text3)", maxHeight: 180, overflowY: "auto" }}>{note.lines.map((l, i) => <li key={i} className="break-words">{l}</li>)}</ul>}
    </div>
  );
}
