// The rail: where the list comes from. All projects, what is open now, one item
// per added folder (Forget sits on the item, shown on hover or focus), the
// places that are not folders, the scope, and the one Add… button.
import type { ReactNode } from "react";
import { FolderIcon, HomeIcon, MonitorIcon, PlusIcon, SparkleIcon, CaretIcon } from "../../lib/glyphIcons.tsx";
import { RIcon } from "../remoteIcons.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { Segmented, Button } from "../workspace/Chrome.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { railLabel, tildify } from "../../lib/projectsPaths.ts";
import type { Source } from "../../lib/projectsView.ts";
import { HAIR, Why } from "./ui.tsx";

const same = (a: Source, b: Source) => a.kind === b.kind && (a.kind !== "folder" || (b.kind === "folder" && a.root === b.root));

function Item({ on, icon, label, count, title, onClick, trailing, hot }: {
  on: boolean; icon: ReactNode; label: string; count?: number | string; title?: string; onClick: () => void; trailing?: ReactNode; hot?: boolean;
}) {
  return (
    <div className="agx-rail-item group flex items-center gap-2 rounded-md min-w-0"
      style={{ minHeight: 32, padding: "0 4px 0 8px", color: on ? "var(--primary-hover)" : "var(--text2)", fontWeight: 600,
        background: on ? "color-mix(in srgb, var(--primary) 10%, transparent)" : hot ? "var(--bg3)" : "transparent" }}>
      <button onClick={onClick} title={title} aria-current={on ? "true" : undefined} className="flex items-center gap-2 min-w-0 flex-1 text-left h-8 bg-transparent border-0 p-0 cursor-pointer" style={{ color: "inherit", font: "inherit", fontSize: 12.5 }}>
        <span className="shrink-0 flex">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count !== undefined && <span className="text-[11px] font-medium" style={{ color: "var(--text4)" }}>{count}</span>}
      </button>
      {trailing}
    </div>
  );
}

export function Rail({ source, setSource, counts, folders, ghCount, onForgetFolder, scopeMachine, canFolders, onScope, diskNote, onAdd, addOpen, busy, addButtonRef }: {
  source: Source; setSource: (s: Source) => void;
  counts: { all: number; open: number; perFolder: Record<string, number> };
  folders: readonly string[]; ghCount: number;
  onForgetFolder: (dir: string) => void;
  scopeMachine: boolean; canFolders: boolean; diskNote?: string; onScope: (machine: boolean) => void;
  onAdd: () => void; addOpen: boolean; busy: boolean; addButtonRef: React.Ref<HTMLButtonElement>;
}) {
  return (
    <nav aria-label="Where projects come from" className="flex flex-col gap-0.5 shrink-0 overflow-hidden" style={{ width: 232, padding: "12px 8px", borderRight: HAIR, background: "color-mix(in srgb, var(--bg3) 35%, var(--surface-card))" }}>
      <Item on={same(source, { kind: "all" })} icon={<HomeIcon size={ICON.sm} />} label="All projects" count={counts.all} onClick={() => setSource({ kind: "all" })} />
      <Item on={same(source, { kind: "open" })} icon={<MonitorIcon size={ICON.sm} />} label="Open now" count={counts.open} onClick={() => setSource({ kind: "open" })} />

      <Cap>Folders</Cap>
      <div className="agx-scroll flex flex-col gap-0.5 overflow-y-auto min-h-0" style={{ maxHeight: 240 }}>
        {folders.length === 0 && <div className="px-2 pb-1.5 text-[11.5px]" style={{ color: "var(--text3)" }}>No folders yet. Add one below.</div>}
        {folders.map((f) => (
          <Item key={f} on={same(source, { kind: "folder", root: f })} icon={<FolderIcon size={ICON.sm} />} label={railLabel(f)} count={counts.perFolder[f] ?? 0}
            title={`${tildify(f)}\n${f}`} onClick={() => setSource({ kind: "folder", root: f.replace(/\/+$/, "") })}
            trailing={
              <button onClick={() => onForgetFolder(f)} disabled={busy} title="Forget this folder — its files are not touched" aria-label={`Forget ${f}`}
                className="agx-forget grid place-items-center shrink-0 rounded-md bg-transparent border-0 cursor-pointer" style={{ width: 22, height: 22, color: "var(--text3)" }}>
                <CloseIcon size={ICON.xs} />
              </button>} />
        ))}
      </div>

      <Cap>Elsewhere</Cap>
      <Item on={same(source, { kind: "gh" })} icon={<RIcon name="cloud" size={ICON.sm} />} label="GitHub repos" count={ghCount} onClick={() => setSource({ kind: "gh" })} />
      <Item on={same(source, { kind: "agents" })} icon={<SparkleIcon size={ICON.sm} />} label="Where agents worked" onClick={() => setSource({ kind: "agents" })} />

      <span className="flex-1" />
      {canFolders && (<div className="rounded-xl p-2 mt-2" style={{ background: "var(--surface-card)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent)" }}>
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text3)" }}>Scope</span>
        <div className="mt-1.5 agx-seg-rail">
          <Why reason={!canFolders && !scopeMachine ? "Add a folder first" : undefined}>
            <Segmented track label="What the panels are held to" value={scopeMachine ? "machine" : "folders"} disabled={busy}
              options={[{ id: "folders", label: "My folders", title: canFolders ? "Hold the panels to the folders you added" : "Add a folder first" }, { id: "machine", label: "Whole machine", title: "No scope: every project on this machine" }]}
              onChange={(v) => { if (v === "machine" ? !scopeMachine : scopeMachine && canFolders) onScope(v === "machine"); }} />
          </Why>
          {diskNote && <div className="mt-1.5 text-[11px]" style={{ color: "var(--text3)" }}>{diskNote}</div>}
        </div>
      </div>)}
      <Button tone={addOpen || !canFolders ? "primary" : "plain"} buttonRef={addButtonRef} className="mt-2 justify-center" onClick={onAdd} disabled={busy} aria-haspopup="menu" aria-expanded={addOpen}>
        <PlusIcon size={ICON.xs} /> Add… <CaretIcon size={ICON.xs} />
      </Button>
    </nav>
  );
}

function Cap({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text3)" }}>{children}</div>;
}
