// "Another git process seems to be running in this repository." tells you nothing
// you can act on. Sometimes a git really is running and the answer is to wait;
// more often a tool call was interrupted and a zero-byte `index.lock` is the only
// thing between you and a commit. This separates the two, which is the whole
// feature. Deliberately NOT modelled on the kernel lock table: git takes no
// kernel lock, so `lslocks` cannot see any of this (see server/src/gitlocks.ts).
// Read on open, on window focus and on Refresh; git announces nothing.
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import type { GitLock, GitLocksReport } from "../../../../shared/types.ts";
import { ICON } from "../../lib/iconSize.ts";
import { forAge, lockGroups } from "../../lib/machineView.ts";
import { useRefreshOnFocus } from "../../lib/useRefreshOnFocus.ts";
import { Button, RefreshButton } from "../workspace/Chrome.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { DetailPane } from "./DetailPane.tsx";
import { ActionNote, Group, Pad, FlagTag } from "./bits.tsx";

export function Locks() {
  const [data, setData] = useState<GitLocksReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The git holding a lock, in the pane the other tabs use: "a rebase is running" and "a fetch is running" are different decisions. */
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(() => {
    setLooking(true);
    api.machineLocks().then((d) => { setData(d); setError(null); }).catch((e) => setError(String(e))).finally(() => setLooking(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  useRefreshOnFocus(true, load);

  const remove = async (l: GitLock) => {
    setBusy(l.path);
    const r = await api.machineUnlock(l.path);
    setBusy(null);
    setNote(r.ok ? (r.detail ?? "removed it") : (r.error ?? "could not remove it"));
    setTimeout(load, 300);
  };

  if (error && !data) return <Pad error onRetry={load}>{error}</Pad>;
  if (!data) return <Pad>Looking through your checkouts…</Pad>;
  if (data.error) return <Pad error onRetry={load}>{data.error}</Pad>;

  const { stuck, held } = lockGroups(data.locks);
  const row = (l: GitLock) => {
    const pid = l.heldBy?.pid ?? null;
    return (
      <div key={l.path} className="mc-lock" data-stale={l.stale || undefined} data-click={pid != null || undefined} data-sel={pid != null && selected === pid || undefined}
        tabIndex={pid != null ? 0 : undefined} onClick={pid != null ? () => setSelected((s) => (s === pid ? null : pid)) : undefined}
        onKeyDown={pid != null ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected((s) => (s === pid ? null : pid)); } } : undefined}>
        <i className="dot" />
        <div style={{ minWidth: 0 }}>
          <div className="nm">{l.name}</div>
          {/* The command, not just the pid: two gits in one checkout are told apart by what they are doing. */}
          <div className="sub" title={l.path}>{`held for ${forAge(l.ageSec)}`}{l.heldBy && ` · pid ${l.heldBy.pid} · ${l.heldBy.cmd}`}</div>
        </div>
        <FlagTag tone="muted" title={l.repo}>{l.repo.split("/").filter(Boolean).pop()}</FlagTag>
        <div className="pa" onClick={(e) => e.stopPropagation()}>
          {/* Only for the ones nothing holds; the server re-decides at the call, but a button that will be refused is a worse way to learn it. */}
          {l.stale && <Button size="compact" square tone="danger" label={`Delete ${l.name}. Nothing is holding it.`} disabled={busy === l.path} onClick={() => void remove(l)}><CloseIcon size={ICON.xs} /></Button>}
        </div>
      </div>
    );
  };

  return (
    <div className="mc-body">
      <div className="mc-main">
        <div className="mc-tool">
          <span className="mc-fine">{data.scanned} checkout{data.scanned === 1 ? "" : "s"} scanned</span>
          <span style={{ marginLeft: "auto" }}><RefreshButton onRefresh={load} spinning={looking} title="Look through the checkouts again" /></span>
        </div>
        {note && <ActionNote onDismiss={() => setNote(null)}>{note}</ActionNote>}
        <div className="mc-locks" style={{ padding: "6px 0 12px" }}>
          {/* The count of checkouts is not decoration: an empty list has to be distinguishable from a sweep that never ran. */}
          <Group label="Stuck" count={stuck.length} hint={`nothing is holding these · ${data.scanned} checkout${data.scanned === 1 ? "" : "s"} scanned`} />
          {stuck.length === 0 && <div className="mc-empty">Nothing is stuck. Every lock found has a git behind it.</div>}
          {stuck.map(row)}
          {held.length > 0 && (<>
            <Group label="In use" count={held.length} hint="a git is working here — these are doing their job" />
            {held.map(row)}
          </>)}
        </div>
      </div>
      {selected != null && <DetailPane pid={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
