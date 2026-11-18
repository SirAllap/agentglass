/*
 * Docker leftovers in the Disk view: the images and volumes no container uses whose owner (a checkout, a commit) is gone,
 * each with its reason. List only, with checkboxes; "Remove selected" asks the server, which reads the list again and
 * removes only what is still orphaned. Nothing here runs on a timer: the list arrives with the disk measure.
 */
import { useState } from "react";
import type { DockerRepoLeftovers } from "../../../../shared/types.ts";
import { humanSize } from "../../../../shared/dockerSize.ts";
import { api } from "../../lib/api.ts";
import { ICON } from "../../lib/iconSize.ts";
import { BranchIcon } from "../../lib/glyphIcons.tsx";
import { Button } from "../workspace/Chrome.tsx";

export function Orphans({ left, readOnly, flash, onDone }: {
  left: DockerRepoLeftovers[]; readOnly: boolean; flash: (ok: boolean, msg: string) => void; onDone: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const failed = left.filter((r) => r.error);
  const rows = left.flatMap((r) => r.orphans.map((o) => ({ repo: r.repo, o, key: `${r.repo}\n${o.kind}:${o.target}` })));
  const warn = failed.length > 0 && (
    <div className="dk-note" role="alert" style={{ ["--tint" as string]: "var(--warning)" }}>
      <BranchIcon size={ICON.md} /><span>Docker leftovers not checked: {failed.map((r) => r.error).join("; ")}</span>
    </div>
  );
  if (!rows.length) return warn || null;
  const toggle = (k: string) => setPicked((cur) => { const n = new Set(cur); if (!n.delete(k)) n.add(k); return n; });
  const bytes = rows.filter((x) => picked.has(x.key)).reduce((n, x) => n + (x.o.bytes ?? 0), 0);
  const remove = async () => {
    setBusy(true);
    try {
      for (const r of left) {
        const mine = rows.filter((x) => x.repo === r.repo && picked.has(x.key));
        if (!mine.length) continue;
        const res = await api.dockerRemoveOrphans(r.repo, mine.filter((x) => x.o.kind === "image").map((x) => x.o.target), mine.filter((x) => x.o.kind === "volume").map((x) => x.o.target));
        flash(res.ok, res.ok ? (res.output ?? "Removed") + (res.error ? ` (${res.error})` : "") : (res.error || "Docker refused"));
      }
      setPicked(new Set()); onDone();
    } catch (e) { flash(false, String(e)); }
    finally { setBusy(false); }
  };
  return (
    <>
    {warn}
    <section className="dk-choice" aria-label="Docker leftovers" style={{ ["--tint" as string]: "var(--warning)" }}>
      <span className="dk-tile"><BranchIcon size={ICON.lg} /></span>
      <div style={{ minWidth: 0 }}>
        <h4>Leftovers of commits and checkouts that are gone</h4>
        <p>{rows.length} image{rows.length === 1 ? "" : "s"} or volume{rows.length === 1 ? "" : "s"} no container uses, with an owner that no longer exists.</p>
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0", display: "grid", gap: 4 }}>
          {rows.map((x) => (
            <li key={x.key}>
              <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <input type="checkbox" checked={picked.has(x.key)} disabled={readOnly || busy} onChange={() => toggle(x.key)} />
                <code>{x.o.target}</code>
                <small>{x.o.kind}{x.o.bytes ? ` · ${humanSize(x.o.bytes)}` : ""} · {x.o.reason}</small>
              </label>
            </li>
          ))}
        </ul>
        <div className="go">
          <Button tint="var(--error)" solid disabled={readOnly || busy || !picked.size} onClick={() => void remove()}>
            {busy ? "Removing…" : `Remove selected${bytes ? ` (frees ${humanSize(bytes)})` : ""}`}
          </Button>
        </div>
      </div>
    </section>
    </>
  );
}
