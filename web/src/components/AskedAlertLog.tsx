/*
 * The last few notifications the person asked for, and what became of each.
 *
 * A quiet list, read when somebody wonders "did it ever tell me?": when it fired,
 * when a window drew it, when it was opened or closed, and why the OS popup was
 * not shown when it was not. It is not a notification kind and never interrupts.
 */
import { useEffect, useState } from "react";
import type { AskedAlert } from "../../../shared/notifyPayload.ts";
import { api } from "../lib/api.ts";
import { SettingRow } from "./SettingRow.tsx";
import { EmptyState, StatusBadge } from "./SettingsKit.tsx";
import { askedState, askedTimeline } from "../lib/askedAudit.ts";

const STATE_WORD = { waiting: "Waiting", opened: "Opened", closed: "Closed" } as const;
const STATE_TONE = { waiting: "info", opened: "ok", closed: "off" } as const;

export function AskedAlertLog() {
  const [rows, setRows] = useState<AskedAlert[] | null>(null);
  useEffect(() => {
    let dead = false;
    api.askedAudit().then((r) => { if (!dead) setRows(r?.audit ?? []); }).catch(() => { if (!dead) setRows([]); });
    return () => { dead = true; };
  }, []);
  if (!rows) return <EmptyState>Loading…</EmptyState>;
  if (!rows.length) return <EmptyState>Nothing asked for has fired yet.</EmptyState>;
  // One row per notification, so the card's divider falls between them.
  return (
    <>
      {rows.slice(0, 10).map((a) => (
        <SettingRow key={a.id} agentExempt label={a.payload.title}
          status={<StatusBadge tone={STATE_TONE[askedState(a)]}>{STATE_WORD[askedState(a)]}</StatusBadge>}
          hint={<>
            {askedTimeline(a)}
            {a.osError && <span className="block mt-1" style={{ color: "var(--warning-ink)" }}>Desktop popup not shown: {a.osError}</span>}
          </>} />
      ))}
    </>
  );
}
