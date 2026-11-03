// Where a checkout's disk went, pinned under the Resources scroller. Asked for,
// never repeated on its own: `du` walks every inode under the directory, which is
// seconds on a repository with a node_modules in it. It reports only: a button
// that deletes a directory because it LOOKS rebuildable is one mislabelled entry
// away from taking somebody's work.
import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import type { GitRepoRef, SpaceReport } from "../../../../shared/types.ts";
import { DiskIcon, RefreshIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { breakdownRows, mb } from "../../lib/machineView.ts";
import { Button } from "../workspace/Chrome.tsx";
import { CheckoutPicker } from "../CheckoutPicker.tsx";

export function Space({ repos }: { repos: GitRepoRef[] }) {
  const [root, setRoot] = useState("");
  const [data, setData] = useState<SpaceReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { setRoot((cur) => cur || repos[0]?.root || ""); }, [repos]);

  const scan = async () => {
    if (!root) return;
    setBusy(true); setOpen(true);
    try { setData(await api.machineSpace(root)); }
    catch (e) { setData({ root, bytes: 0, freeable: 0, dirs: [], error: String(e) }); }
    finally { setBusy(false); }
  };
  const ok = data && !data.error;
  const rows = ok ? breakdownRows(data.dirs) : [];

  return (
    <div className="mc-spf" aria-label="Disk of a checkout">
      <div className="mc-spt">
        <span style={{ display: "flex", color: "var(--text3)" }}><DiskIcon size={ICON.xs} /></span>
        <b>Disk</b>
        <CheckoutPicker repos={repos} value={root} onPick={(r) => { setRoot(r); setData(null); setOpen(false); }} placeholder="Pick a checkout" triggerMaxWidth={240} />
        {ok && <span><b>{mb(data.bytes)}</b>{data.freeable > 0 && <span className="ok"> · {mb(data.freeable)} rebuildable</span>}</span>}
        <span className="grow" />
        {ok && <Button size="compact" tone="quiet" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Show"} the breakdown</Button>}
        <Button disabled={busy || !root} onClick={() => void scan()}>
          {busy ? <><span className="mc-spin"><RefreshIcon size={ICON.xs} /></span>Measuring…</> : <><RefreshIcon size={ICON.xs} />{data ? "Measure again" : "Measure"}</>}
        </Button>
      </div>
      {!data && !busy && <div className="mc-fine">Nothing is measured until you ask — <code>du</code> reads every file under the checkout, which takes seconds.</div>}
      {data?.error && <div className="mc-spt"><span className="err">{data.error}</span></div>}
      {ok && open && (<>
        <div className="mc-tiles">
          <div className="mc-stt"><small>On disk</small><b>{mb(data.bytes)}</b></div>
          <div className="mc-stt"><small>Rebuildable</small><b style={{ color: "var(--success-ink,var(--success))" }}>{mb(data.freeable)}</b></div>
          <div className="mc-stt"><small>Biggest</small><b>{data.dirs[0]?.name ?? "—"}</b></div>
        </div>
        {rows.map((d) => (
          <div key={d.path} className="mc-spr">
            <div className="mc-bar2"><i data-rb={d.reclaimable || undefined} style={{ width: `${d.pct}%` }} /></div>
            <span style={d.reclaimable ? { color: "var(--warning-ink,var(--warning))" } : undefined}>{d.name}</span>
            <small>{d.reclaimable ? "rebuildable" : ""}</small>
            <span className="r">{mb(d.bytes)}</span>
          </div>
        ))}
        <div className="mc-fine">Read only — nothing here deletes anything.</div>
      </>)}
    </div>
  );
}
