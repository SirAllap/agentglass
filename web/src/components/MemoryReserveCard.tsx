// The memory reserve, on Settings ▸ Tools & services.
//
// The app reserves memory on its own systemd unit at every start, and that
// alone is honoured by nobody: three levels above it belong to the system and
// default to none, and a level without a reserve cancels the ones under it.
// Setting them takes the person's password, once. This card reads the state
// and carries the one button; it never asks on its own.
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { ICON } from "../lib/iconSize.ts";
import { MEMORY_RESERVE_WHAT, memoryReserveNote } from "../lib/memoryReserveNote.ts";
import type { MemoryReserveReport } from "../../../shared/memoryReserve.ts";
import { ServerIcon } from "./settingsNavIcons.tsx";
import { ProblemNote, SettingsCard, StatusBadge } from "./SettingsKit.tsx";
import { Button } from "./workspace/Chrome.tsx";

export function MemoryReserveCard({ open, nonce, show }: { open: boolean; nonce: number; show: "all" | "ready" | "needs" }) {
  const [report, setReport] = useState<MemoryReserveReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => { void api.memoryReserve().then(setReport).catch(() => setReport(null)); };
  useEffect(() => { if (open) load(); }, [open, nonce]);

  if (!report) return null;
  const note = memoryReserveNote(report);
  // Under the page's own filter: a reserve that holds is "ready", one that does not "needs you".
  if (show === "ready" && note.tone !== "ok") return null;
  if (show === "needs" && note.tone !== "warn") return null;

  const press = (id: "apply" | "undo") => {
    setBusy(true); setErr(null);
    void api.setMemoryReserve(id)
      .then((r) => { if (r.report) setReport(r.report); if (!r.ok) setErr(r.error || "Nothing was changed."); })
      .catch(() => setErr("Could not reach the server, so nothing was changed."))
      .finally(() => setBusy(false));
  };

  return (
    <SettingsCard title="Memory reserve" icon={<ServerIcon size={ICON.sm} />} desc={MEMORY_RESERVE_WHAT}
      tone={note.tone === "warn" ? "decision" : "default"}
      status={<StatusBadge tone={note.tone}>{note.badge}</StatusBadge>}
      actions={note.action ? <Button pending={busy} onClick={() => press(note.action!.id)}>{note.action.label}</Button> : undefined}>
      <div className="agx-chk-more"><p className="m-0">{note.line}</p></div>
      {err && <ProblemNote title="The reserve was not changed">{err}</ProblemNote>}
    </SettingsCard>
  );
}
