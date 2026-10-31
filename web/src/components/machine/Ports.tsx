// Open ports, and which checkout each one belongs to. `ss` answers "what is
// listening"; the whole point here is the translation from a pid back to "my dev
// server in that worktree", and a Stop that asks first.
import { useMemo, useState } from "react";
import { api } from "../../lib/api.ts";
import type { PortEntry } from "../../../../shared/types.ts";
import { HAS_BROWSER } from "../../lib/desktop.ts";
import { openExternal } from "../../lib/externalUrl.ts";
import { requestBrowserNav } from "../../lib/browserNav.ts";
import { ICON } from "../../lib/iconSize.ts";
import { CaretIcon, CopyIcon } from "../../lib/glyphIcons.tsx";
import { canStop, checkoutName, checkoutTitle, forAge, portFlags, portUrl, splitPorts } from "../../lib/machineView.ts";
import { Button, FilterField, RefreshButton } from "../workspace/Chrome.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { DetailPane } from "./DetailPane.tsx";
import { ActionNote, Group, Pad, StopConfirm, FlagTag } from "./bits.tsx";
import type { PortsState } from "./usePorts.ts";

export function Ports({ ports, onOpenBrowser }: { ports: PortsState; onOpenBrowser?: () => void }) {
  const { data, error, looking, load } = ports;
  const [showExternal, setShowExternal] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Which row's detail is open, by pid. A second question, not a permanent third of the dialog. */
  const [selected, setSelected] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const { mine, rest } = useMemo(() => splitPorts(data?.ports ?? [], q), [data, q]);

  const open = (p: PortEntry) => {
    const url = portUrl(p);
    if (HAS_BROWSER && onOpenBrowser) { requestBrowserNav(url); onOpenBrowser(); return; }
    openExternal(url);
  };
  const stop = async (p: PortEntry) => {
    if (p.pid == null) return;
    setArmed(null); setBusy(p.pid);
    const r = await api.machineKill(p.pid);
    setBusy(null);
    setNote(r.ok ? (r.detail ?? "asked it to stop") : (r.error ?? "could not stop it"));
    // SIGTERM asks, and a server that shuts down cleanly takes a moment: one look afterwards, not a timer.
    setTimeout(load, 600);
  };

  if (error && !data) return <Pad error onRetry={load}>{error}</Pad>;
  if (!data) return <Pad>Looking at the sockets…</Pad>;
  if (data.error) return <Pad error onRetry={load}>{data.error}</Pad>;

  return (
    <div className="mc-body">
      <div className="mc-main">
        <div className="mc-tool">
          <div className="mc-fld"><FilterField value={q} onChange={setQ} placeholder="Filter by port, process, checkout or what started it…" label="Filter ports" /></div>
          <span style={{ marginLeft: "auto" }}><RefreshButton onRefresh={load} spinning={looking} title="Look at the sockets again" /></span>
        </div>
        {note && <ActionNote onDismiss={() => setNote(null)}>{note}</ActionNote>}
        <div className="mc-scr" style={{ flex: 1, padding: "6px 0 12px" }}>
          <Group label="Yours" count={mine.length} />
          {mine.length === 0 && <div className="mc-empty">{q.trim() ? `Nothing of yours matches “${q.trim()}”.` : "Nothing of yours is listening right now."}</div>}
          {mine.map((p) => (
            <div key={`${p.addr}:${p.port}:${p.pid}`} className="mc-prow" data-sel={selected === p.pid || undefined}
              tabIndex={p.pid != null ? 0 : undefined}
              onClick={p.pid != null ? () => setSelected((s) => (s === p.pid ? null : p.pid)) : undefined}
              onKeyDown={p.pid != null ? (e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setSelected((s) => (s === p.pid ? null : p.pid)); } } : undefined}>
              <i className="dot" />
              <b className="pn">{p.port}</b>
              <div className="pm">
                <span className="pp">{p.proc ?? "—"}
                  {p.ancestry.length > 0 && <small title={`Started by: ${p.ancestry.map((a) => `${a.name} (pid ${a.pid})`).join(" ← ")}`}> ← {p.ancestry.map((a) => a.name).join(" ← ")}</small>}
                </span>
                <span className="pd2">{p.addr}:{p.port}{p.pid != null && ` · pid ${p.pid}`}{p.ageSec != null && ` · up ${forAge(p.ageSec)}`}</span>
              </div>
              <div className="pf">{portFlags(p).map((f) => <FlagTag key={f.key} tone={f.tone} title={f.title}>{f.label}</FlagTag>)}</div>
              <span className="pc">{checkoutName(p) && <span className="mc-tag" data-co style={{ "--tint": "var(--info)" } as React.CSSProperties} title={checkoutTitle(p)}>{checkoutName(p)}</span>}</span>
              {/* The row selects; the buttons act. */}
              <div className="pa" data-armed={armed === p.pid || undefined} onClick={(e) => e.stopPropagation()}>
                {armed === p.pid && p.pid != null
                  ? <StopConfirm pid={p.pid} onYes={() => void stop(p)} onNo={() => setArmed(null)} />
                  : (<>
                    <Button size="compact" square tone="quiet" label={HAS_BROWSER && onOpenBrowser ? "Open in the browser tab" : "Open in your browser"} onClick={() => open(p)}>↗</Button>
                    <Button size="compact" square tone="quiet" label="Copy the address" onClick={() => void navigator.clipboard?.writeText(`http://localhost:${p.port}`)}><CopyIcon size={ICON.xs} /></Button>
                    {canStop(p) && <Button size="compact" square tone="quiet" label="Ask this process to stop (SIGTERM)" disabled={busy === p.pid} onClick={() => setArmed(p.pid)}><CloseIcon size={ICON.xs} /></Button>}
                  </>)}
              </div>
            </div>
          ))}
          {/* Collapsed, because it is thirty rows of system daemons and the answer is almost never in it; present, because "who has 8080?" is sometimes exactly the question. */}
          <button type="button" className="mc-gh" aria-expanded={showExternal} onClick={() => setShowExternal((v) => !v)}>
            <span className="lead"><CaretIcon size={ICON.xs} /> Everything else</span>
            <span className="hint">other users' processes — the system will not say whose</span>
            <span className="n">{rest.length}</span>
          </button>
          {/* Only ever ours get a detail: /proc will not describe another account's process. */}
          {showExternal && rest.map((p) => (
            <div key={`${p.addr}:${p.port}:${p.pid}`} className="mc-prow" data-ext>
              <i className="dot" /><b className="pn">{p.port}</b>
              <div className="pm"><span className="pp">{p.proc ?? "—"}</span><span className="pd2">{p.addr}:{p.port}</span></div>
              <div className="pf">{portFlags(p).map((f) => <FlagTag key={f.key} tone={f.tone} title={f.title}>{f.label}</FlagTag>)}</div>
              <span /><span />
            </div>
          ))}
        </div>
      </div>
      {selected != null && <DetailPane pid={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
