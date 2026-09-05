/*
 * Volumes, with the three facts that were missing.
 *
 * The old table was two columns: name and "local". Everything anybody actually
 * wants to know about a volume was absent — how big it is, who is holding it,
 * and whether what is inside it is yours. That last one is not a nicety on this
 * machine: every worktree shares the same global volumes, so the bundle your
 * app serves may well have been built by a branch you have never checked out,
 * and until now nothing said so.
 *
 * Sizes are the expensive half (`docker system df -v` walks every layer), so
 * they are fetched when this section is opened and never on the poll. The
 * ownership half is free — it comes from agentglass's own ledger — so it is
 * already in the list.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DockerDisk, DockerPeek, DockerVolume, DockerVolumeDetail } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { humanSize, sinceLabel } from "../../lib/dockerVolumeView.ts";

function Chip({ text, tint, title }: { text: string; tint: string; title?: string }) {
  return (
    <span title={title} className="text-[9.5px] px-1.5 py-0.5 rounded-md whitespace-nowrap"
      style={{ color: tint, border: `1px solid color-mix(in srgb, ${tint} 40%, transparent)`, background: `color-mix(in srgb, ${tint} 10%, transparent)` }}>
      {text}
    </span>
  );
}

export function Volumes({ volumes }: { volumes: DockerVolume[] }) {
  const [sizes, setSizes] = useState<Record<string, number | null> | null>(null);
  const [sizeErr, setSizeErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<DockerVolumeDetail | null>(null);
  const [peek, setPeek] = useState<DockerPeek | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  /* One call for every size. `docker system df -v` is THE expensive call on
     this surface — the daemon adds up every layer on the machine — so it is
     made once when this section opens, and never on the poll. Asking per row
     would be thirty of them. */
  useEffect(() => {
    let live = true;
    void api.dockerDisk().then((d: DockerDisk & { error?: string }) => {
      if (!live) return;
      if (d?.error) { setSizeErr(d.error); return; }
      setSizes(Object.fromEntries((d.volumes_ ?? []).map((v) => [v.name, v.bytes])));
    }).catch((e) => { if (live) setSizeErr(String(e)); });
    return () => { live = false; };
  }, []);

  const open = useCallback(async (name: string) => {
    setSel(name); setDetail(null); setPeek(null); setPath("");
    setDetail(await api.dockerVolume(name));
  }, []);

  const look = useCallback(async (name: string, at: string) => {
    setBusy(true);
    setPath(at);
    try { setPeek(await api.dockerPeek(name, at)); }
    finally { setBusy(false); }
  }, []);

  const rows = useMemo(
    () => [...volumes].sort((a, b) => (sizes?.[b.name] ?? 0) - (sizes?.[a.name] ?? 0) || a.name.localeCompare(b.name)),
    [volumes, sizes],
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="agx-scroll flex-1 min-h-0 overflow-auto p-4">
        {sizeErr && <div className="text-[11px] mb-2" style={{ color: "var(--warning)" }}>{sizeErr}</div>}
        <table className="w-full text-[11px]" style={{ color: "var(--text2)" }}>
          <thead className="text-[9.5px] uppercase tracking-wider t-dim2 text-left">
            <tr>
              {["Volume", "Size", "Held by", "Last written", ""].map((h) => <th key={h} className="py-1.5 pr-4 font-semibold">{h}</th>)}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((v) => (
              <tr key={v.name} onClick={() => open(v.name)}
                className="cursor-pointer"
                style={{
                  borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)",
                  background: sel === v.name ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent",
                }}>
                <td className="py-1.5 pr-4 break-all" style={{ color: "var(--text)" }}>{v.name}</td>
                <td className="py-1.5 pr-4">{sizes ? humanSize(sizes[v.name] ?? null) : "…"}</td>
                <td className="py-1.5 pr-4">
                  {/* The fact that explains "why is my app serving somebody
                      else's bundle". One worktree is normal; six is the thing
                      nothing else on this machine reports. */}
                  {v.worktrees?.length
                    ? <Chip text={v.worktrees.length === 1 ? v.worktrees[0]! : `${v.worktrees.length} worktrees`}
                        tint={v.worktrees.length > 1 ? "var(--warning)" : "var(--text3)"}
                        title={v.worktrees.join("\n")} />
                    : <span className="t-dim2">unknown</span>}
                </td>
                <td className="py-1.5 pr-4">
                  {v.lastWrite
                    ? <span title={`${v.lastWrite.via} · ${v.lastWrite.branch ?? "detached"} · ${v.lastWrite.at}`}>
                        {v.lastWrite.worktree} <span className="t-dim2">{sinceLabel(v.lastWrite.at)}</span>
                      </span>
                    /* Never observed. A real answer, and usually the one that
                       says this volume is safe to delete. */
                    : <span className="t-dim2">—</span>}
                </td>
                <td className="py-1.5 pr-4 text-right">
                  <button onClick={(e) => { e.stopPropagation(); void open(v.name).then(() => look(v.name, "")); }}
                    className="text-[9.5px] px-2 py-0.5 rounded-md min-h-[20px]"
                    style={{ color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
                    look inside
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td className="py-3 t-dim2">No volumes</td></tr>}
          </tbody>
        </table>
      </div>

      {sel && (
        <div className="shrink-0 border-t max-h-[45%] agx-scroll overflow-auto" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
          <div className="flex items-center gap-2 px-4 py-2">
            <span className="text-[12px] font-medium break-all" style={{ color: "var(--text)" }}>{sel}</span>
            {detail?.bytes != null && <Chip text={humanSize(detail.bytes)} tint="var(--text3)" />}
            <button onClick={() => setSel(null)} className="ml-auto text-[10px] px-2 py-0.5 rounded min-h-[20px]" style={{ color: "var(--text3)" }}>close</button>
          </div>

          <div className="px-4 pb-2 flex flex-col gap-1.5 text-[11px]">
            <div className="flex gap-3">
              <span className="w-28 shrink-0 t-dim2">held by</span>
              <span className="min-w-0">
                {detail?.mountedBy.length
                  ? detail.mountedBy.map((m) => `${m.name}${m.state === "running" ? "" : ` (${m.state})`}`).join(", ")
                  : <span className="t-dim2">nothing right now</span>}
              </span>
            </div>
            <div className="flex gap-3">
              <span className="w-28 shrink-0 t-dim2">last written by</span>
              <span className="min-w-0">
                {detail?.lastWrite
                  ? <>{detail.lastWrite.worktree} · <span className="t-dim2">{detail.lastWrite.via}</span> · {sinceLabel(detail.lastWrite.at)}</>
                  : <span className="t-dim2">agentglass has not seen anything write to it</span>}
              </span>
            </div>
            {!!detail?.worktrees.length && (
              <div className="flex gap-3">
                <span className="w-28 shrink-0 t-dim2">worktrees</span>
                <span className="min-w-0 break-all">{detail.worktrees.join(", ")}</span>
              </div>
            )}
          </div>

          <div className="px-4 pb-3">
            <div className="flex items-center gap-2 mb-1">
              <button onClick={() => look(sel, "")} disabled={busy}
                className="text-[10px] px-2 py-0.5 rounded-md min-h-[20px] disabled:opacity-40"
                style={{ color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
                {busy ? "looking…" : "look inside"}
              </button>
              {path && (
                <span className="text-[10px] t-dim2 break-all">/{path}
                  <button onClick={() => look(sel, path.split("/").slice(0, -1).join("/"))} className="ml-2 min-h-[20px]" style={{ color: "var(--primary-hover)" }}>up</button>
                </span>
              )}
              {/* Which image the look was taken with, so it is obvious nothing
                  was pulled to answer a click. */}
              {peek?.image && <span className="ml-auto text-[9.5px] t-dim2">via {peek.image}</span>}
            </div>

            {peek && !peek.ok && (
              <div className="text-[10.5px]" style={{ color: "var(--warning)" }}>
                {peek.error}
                {peek.hint && <div className="mt-1 t-dim2 break-all" style={{ fontFamily: "ui-monospace, monospace" }}>{peek.hint}</div>}
              </div>
            )}
            {peek?.entries && (
              <div className="text-[10.5px]" style={{ fontFamily: "ui-monospace, monospace", color: "var(--text2)" }}>
                {peek.entries.map((e) => (
                  <div key={e.name} className="flex gap-3">
                    <span className="flex-1 min-w-0 truncate" style={{ color: e.dir ? "var(--primary-hover)" : "var(--text2)" }}>
                      {e.dir
                        ? <button onClick={() => look(sel, path ? `${path}/${e.name}` : e.name)} className="text-left min-h-[20px]">{e.name}/</button>
                        : e.name}
                    </span>
                    <span className="w-20 text-right tabular-nums t-dim2">{e.dir ? "" : humanSize(e.bytes)}</span>
                    <span className="w-32 text-right t-dim2">{e.when}</span>
                  </div>
                ))}
                {!peek.entries.length && <div className="t-dim2">empty</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
