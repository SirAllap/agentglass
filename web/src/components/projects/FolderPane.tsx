// Add › Folder: the typed path, checked as it is typed. The server reads (and
// saves nothing) to say whether the folder exists and how many projects it
// would bring in, so the answer is under the field before the button is pressed
// — green with a count, red with the closest folders, amber for zero.
import { useEffect, useRef, useState } from "react";
import type { FolderPrecheck } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { ICON } from "../../lib/iconSize.ts";
import { folderVerdict, tildify } from "../../lib/projectsPaths.ts";
import { Button, EDGE } from "../workspace/Chrome.tsx";
import { BranchIcon, DoneIcon, FolderIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { Foot, HAIR, HUE, Kbd, PaneHead, StateCard, Tile, Why } from "./ui.tsx";
import { FolderField } from "./FolderField.tsx";

const CHECK_MS = 150;

export function FolderPane({ roots, listedRoots, busy, error, onAdd, onBack, onChooser }: {
  roots: readonly string[]; listedRoots: readonly string[]; busy: boolean; error: string;
  onAdd: (dir: string) => void; onBack: () => void; onChooser?: () => void;
}) {
  const [path, setPath] = useState("");
  const [pre, setPre] = useState<FolderPrecheck | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const p = path.trim();
    const n = ++seq.current;
    setPre(null);
    if (!p) return;
    const t = setTimeout(() => { api.fsPrecheck(p).then((r) => { if (n === seq.current) setPre(r); }).catch(() => { /* the button stays off */ }); }, CHECK_MS);
    return () => clearTimeout(t);
  }, [path]);

  const under = pre?.path ? listedRoots.filter((r) => r === pre.path || r.startsWith(pre.path + "/")).length : 0;
  const v = folderVerdict(path, pre, under, !!pre?.path && roots.some((r) => r.replace(/\/+$/, "") === pre.path));
  const tone = v.state === "ok" ? "success" : v.state === "missing" ? "error" : undefined;
  const go = () => { if (v.canAdd && !busy) onAdd(path.trim()); };
  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <PaneHead title="Add a folder" onBack={onBack} />
      <div className="pm-px mt-0.5 grid gap-1.5 shrink-0">
        <label className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text3)" }} htmlFor="folder-path">Folder path</label>
        <FolderField label="Folder path" value={path} onChange={setPath} onSubmit={go} autoFocus tone={tone} describedBy="folder-help"
          placeholder="~/code, or ~/code/my-project"
          trailing={v.state === "ok" ? <span style={{ color: HUE.success }}><DoneIcon size={ICON.md} /></span> : v.state === "missing" ? <span style={{ color: HUE.error }}><WarningIcon size={ICON.md} /></span> : undefined} />
        <div id="folder-help" className="text-[11.5px]" role="status" style={{ color: v.state === "ok" ? "var(--success)" : v.state === "missing" ? "var(--error)" : "var(--text3)", overflowWrap: "anywhere", minHeight: 16 }}>
          {v.help || "Every git repository inside it is listed here. The folder itself is never touched."}
        </div>
      </div>

      {v.state === "zero" && (
        <StateCard hue="warning" icon={<FolderIcon size={ICON.lg} />} title="No git repositories here">
          Add it anyway as a folder to watch? Projects you create or clone in it later will appear.
        </StateCard>
      )}
      {v.state === "ok" && pre && (
        <>
          <div className="pm-px mt-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--text3)" }}>Will be added <span className="font-normal" style={{ color: "var(--text4)" }}>{v.fresh} new</span></div>
          <div className="agx-scroll pm-mx mt-1.5 rounded-xl overflow-y-auto min-h-0" style={{ border: EDGE }}>
            {pre.sample.map((s) => (
              <div key={s.path} className="flex items-center gap-2.5 px-3 py-2" style={{ borderBottom: HAIR }}>
                <Tile hue="success"><BranchIcon size={ICON.xs} /></Tile>
                <span className="min-w-0 flex-1"><b className="block text-[12.5px] truncate" title={s.name}>{s.name}</b><span className="block font-mono text-[11px] truncate" style={{ color: "var(--text3)" }} title={s.path}>{tildify(s.path)}</span></span>
              </div>
            ))}
            {pre.repos > pre.sample.length && <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text3)" }}>and {pre.repos - pre.sample.length} more</div>}
          </div>
        </>
      )}
      {error && <StateCard hue="error" icon={<WarningIcon size={ICON.lg} />} title="Could not add that folder">{error}</StateCard>}
      <span className="flex-1" />
      <Foot hint={<><span><Kbd>Esc</Kbd> back</span><span><Kbd>⏎</Kbd> add</span></>}>
        {onChooser && <Button onClick={onChooser} disabled={busy}>Choose with the system chooser…</Button>}
        <Button onClick={onBack}>Cancel</Button>
        <Why reason={v.canAdd ? undefined : v.reason}>
          <Button tone="primary" pending={busy} disabled={!v.canAdd || busy} onClick={go} className="px-4">{v.label}</Button>
        </Why>
      </Foot>
    </div>
  );
}
