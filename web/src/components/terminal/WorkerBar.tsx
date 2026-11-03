/*
 * The bar over a headless worker's tab.
 *
 * A worker runs ONE turn in a pane whose own stdin is a file: what is typed
 * there reaches nobody, and the way to end it early is the stop the CLI gives.
 * So the tab says both, and offers that stop. It reads `/agents/named` because
 * a headless OpenCode turn fires no hooks and is on no board (lib/workerBar.ts
 * explains the filter).
 */
import { useEffect, useState } from "react";
import { agentProvider } from "../../../../shared/agentKinds.ts";
import { api } from "../../lib/api.ts";
import { usePoll } from "../../lib/usePoll.ts";
import { workerAt, workerStatus, type NamedAgentRow } from "../../lib/workerBar.ts";
import { Button, CTRL_H, LINE } from "../workspace/Chrome.tsx";

const STOP_TIP = "Stop this worker: the same stop `agentglass-agent stop` gives. It ends the turn and closes this tab.";

export function WorkerBar({ paneId, open }: { paneId: string | null; open: boolean }) {
  const [rows, setRows] = useState<NamedAgentRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const read = () => {
    if (!paneId) return;
    void api.namedAgents(true, paneId).then((r) => { if (r.ok) setRows(r.result?.agents ?? []); }).catch(() => {});
  };
  usePoll(open && paneId !== null, read, 4000);
  useEffect(() => { if (open && paneId) read(); }, [open, paneId]);

  const worker = workerAt(rows, paneId);
  if (!worker) return null;
  const engine = agentProvider(worker.kind)?.title ?? worker.kind;
  const ended = worker.endedAt !== null;
  const stop = async () => {
    setBusy(true); setError("");
    const r = await api.agentStop(worker.name).catch(() => ({ ok: false, error: "that did not go through" }));
    setBusy(false);
    if (!r.ok) setError(r.error ?? "it did not stop");
    read();
  };

  return (
    <div className="shrink-0 flex items-center gap-2 px-3 text-[11px] min-w-0"
      style={{ minHeight: CTRL_H.strip + 4, background: "var(--surface-inset)", borderBottom: LINE, color: "var(--text2)" }}>
      <span className="truncate min-w-0" data-tip={`${worker.name} was started by the policy as a headless worker: it runs one turn and cannot be steered from this tab.`}>
        <b style={{ color: "var(--text)" }}>{worker.name}</b>
        {` · ${engine} · `}
        {ended ? "its turn has ended; this tab is kept for reading" : "one turn at a time — this tab cannot be typed to"}
      </span>
      {error && <span className="shrink-0" style={{ color: "var(--warning-ink)" }}>{error}</span>}
      <span className="ml-auto shrink-0 flex items-center gap-2">
        <span className="tabular-nums" style={{ color: worker.resultMissing ? "var(--warning-ink)" : "var(--text4)" }}>
          {workerStatus(worker)}
        </span>
        <Button size="compact" tone="plain" disabled={busy} data-tip={STOP_TIP} onClick={() => void stop()}>
          {busy ? "Stopping…" : "Stop"}
        </Button>
      </span>
    </div>
  );
}
