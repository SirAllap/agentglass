// The small panes and layers around the list: the GitHub shelf, the empty first
// run, the keyboard legend and the Undo toast.
import { useEffect, useState } from "react";
import { CAN_BROWSE_FOLDER } from "../../lib/desktop.ts";
import { ICON } from "../../lib/iconSize.ts";
import { FolderIcon, SparkleIcon, UndoIcon } from "../../lib/glyphIcons.tsx";
import { RIcon } from "../remoteIcons.tsx";
import { RemoteShelfRows, type useRemoteRefresh } from "../remoteRepoRows.tsx";
import type { RemoteRepo } from "../../lib/remoteRepos.ts";
import { Button } from "../workspace/Chrome.tsx";
import { Foot, HAIR, Kbd, StateCard, Tile, wash } from "./ui.tsx";
import { TOAST_MS, type Toast } from "./useProjectsModal.ts";

export function GithubShelf({ rows, total, ticks, busy, state, onOpen, onAdd }: {
  rows: RemoteRepo[]; total: number; ticks: string[]; busy: boolean; state: ReturnType<typeof useRemoteRefresh>; onOpen: (repo: string) => void; onAdd: () => void;
}) {
  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <div className="flex items-center gap-2.5 pm-px shrink-0" style={{ height: 46 }}>
        <h3 className="m-0 text-[14px] font-bold" style={{ color: "var(--text)" }}>GitHub repos</h3>
        <span className="text-[12px]" style={{ color: "var(--text3)" }}>read-only, nothing is cloned · {total}</span>
        <span className="flex-1" />
        <Button size="compact" onClick={onAdd} disabled={busy}>Add a GitHub repo</Button>
      </div>
      <div className="agx-scroll flex-1 min-h-0 overflow-y-auto px-2">
        {rows.length ? <RemoteShelfRows rows={rows} ticks={ticks} disabled={busy} state={state} onOpen={onOpen} /> : (
          <StateCard hue="info" icon={<RIcon name="cloud" size={ICON.lg} />} title={total ? "No GitHub repo matches that search" : "No GitHub repos yet"}
            actions={total ? undefined : <Button tone="primary" onClick={onAdd}>Add a GitHub repo</Button>}>
            Add one to review its pull requests without cloning it.
          </StateCard>
        )}
      </div>
    </div>
  );
}

/** Nothing listed, no folder: one big action, and the other ways in beside it. */
export function FirstRun({ busy, onChooser, onTyped, onAgents, onGithub }: { busy: boolean; onChooser: () => void; onTyped: () => void; onAgents: () => void; onGithub: () => void }) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
    <div className="flex flex-col items-center justify-center text-center gap-2.5 flex-1" style={{ padding: "30px 44px" }}>
      <Tile size={56} hue="primary"><FolderIcon size={26} /></Tile>
      <h3 className="m-0 text-[18px] font-bold" style={{ color: "var(--text)" }}>Add the folder where your projects live</h3>
      <p className="m-0 text-[12.5px]" style={{ color: "var(--text3)", maxWidth: 440 }}>Every git repo inside it appears here, and stays up to date. Nothing is copied or moved.</p>
      <div className="flex items-center gap-2 mt-1.5">
        <Button tone="primary" onClick={CAN_BROWSE_FOLDER ? onChooser : onTyped} disabled={busy} className="pm-px" style={{ height: 36 }}>{CAN_BROWSE_FOLDER ? "Choose a folder…" : "Type a folder path"}</Button>
        {CAN_BROWSE_FOLDER && <Button onClick={onTyped} disabled={busy} style={{ height: 36 }}>Type a path</Button>}
        <Button onClick={onGithub} disabled={busy} style={{ height: 36 }}><RIcon name="cloud" size={ICON.xs} /> GitHub repo</Button>
        <Button onClick={onAgents} disabled={busy} style={{ height: 36 }}><SparkleIcon size={ICON.xs} /> Where agents worked</Button>
      </div>
      <p className="m-0 text-[11.5px]" style={{ color: "var(--text4)" }}>or type a folder path · <Kbd>⏎</Kbd> to start</p>
    </div>
    <Foot hint={<><span><Kbd>↑↓</Kbd> move</span><span><Kbd>Space</Kbd> tick</span><span><Kbd>⏎</Kbd> open</span><span><Kbd>/</Kbd> search</span><span><Kbd>Esc</Kbd> close</span></>}>
      <span className="text-[12px] font-semibold whitespace-nowrap" style={{ color: "var(--text)" }}>0 ticked <span className="font-normal" style={{ color: "var(--text3)" }}>of 0</span></span>
      <Button tone="primary" disabled className="px-4" style={{ minWidth: 132, justifyContent: "center" }}>Open</Button>
    </Foot>
    </div>
  );
}

export function ForgotFolder({ path, count, onUndo, onAdd }: { path: string; count: number; onUndo: () => void; onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2.5 flex-1" style={{ padding: "30px 44px" }}>
      <Tile size={56} hue="muted"><FolderIcon size={26} /></Tile>
      <h3 className="m-0 text-[18px] font-bold" style={{ color: "var(--text)" }}>Folder forgotten</h3>
      <p className="m-0 text-[12.5px]" style={{ color: "var(--text3)", maxWidth: 440, overflowWrap: "anywhere" }}>{path}{count ? ` and its ${count} project${count === 1 ? "" : "s"}` : ""} are off your list. The files are where they were.</p>
      <div className="flex items-center gap-2 mt-1.5"><Button tone="primary" onClick={onUndo}><UndoIcon size={ICON.xs} /> Undo</Button><Button onClick={onAdd}>Add another folder</Button></div>
    </div>
  );
}

const KEYS: readonly (readonly [string[], string])[] = [
  [["Esc"], "Close, or go back one step"], [["/"], "Focus the search box"], [["↑", "↓"], "Move the highlight"], [["Space"], "Tick / untick the highlighted row"],
  [["⏎"], "Open the highlighted row, or all ticked"], [["Ctrl", "A"], "Tick everything shown"], [["N"], "Add… (then 1–4)"], [["Del"], "Forget the highlighted row (undo with Z)"],
  [["[", "]"], "Previous / next source in the rail"], [["?"], "This legend"],
];

export function KeysLegend({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-[8] grid place-items-center" style={{ background: wash("var(--text)", 18) }} onClick={onClose}>
      <div role="dialog" aria-label="Keyboard" className="rounded-xl pt-3.5 pb-2" style={{ width: 560, background: "var(--surface-card)", boxShadow: "0 24px 60px -16px rgba(0,0,0,0.5)" }} onClick={(e) => e.stopPropagation()}>
        <h3 className="pm-mx mt-0 mb-2 text-[14px] font-bold" style={{ color: "var(--text)" }}>Keyboard</h3>
        <div className="grid gap-x-6 gap-y-2 pm-px pb-3" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))" }}>
          {KEYS.map(([keys, what]) => (
            <div key={what} className="flex items-center gap-2.5 text-[12px]" style={{ minHeight: 30, borderBottom: HAIR, color: "var(--text2)" }}>
              <span className="flex gap-1 shrink-0" style={{ minWidth: 44 }}>{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span><span>{what}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A line with one verb. Undo is a key as well as a button, and leaves on its own. */
export function UndoToast({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  const [left, setLeft] = useState(Math.round(TOAST_MS / 1000));
  useEffect(() => {
    setLeft(Math.round(TOAST_MS / 1000));
    const t = setTimeout(onDone, TOAST_MS);
    const tick = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => { clearTimeout(t); clearInterval(tick); };
  }, [toast.id, onDone]);
  return (
    <div role="status" aria-live="polite" className="absolute flex items-center gap-3 rounded-xl" data-toast
      style={{ left: "50%", bottom: 76, transform: "translateX(-50%)", maxWidth: "92%", padding: "10px 12px", background: "var(--text)", color: "var(--bg)", zIndex: 7, boxShadow: "0 10px 30px -10px rgba(0,0,0,0.5)" }}>
      <span className="truncate text-[12px]" title={toast.text}>{toast.text}</span>
      {toast.undo && <button onClick={() => { toast.undo!(); onDone(); }} className="inline-flex items-center gap-1 font-bold bg-transparent border-0 p-0 cursor-pointer text-[12px]" style={{ color: "var(--primary-hover)" }}><UndoIcon size={ICON.xs} /> Undo <Kbd>Z</Kbd></button>}
      {toast.undo && <span className="text-[11px] tabular-nums" style={{ opacity: 0.6 }}>{left} s</span>}
      {toast.action && <button onClick={() => { toast.action!.run(); onDone(); }} className="font-bold bg-transparent border-0 p-0 cursor-pointer text-[12px]" style={{ color: "var(--primary-hover)" }}>{toast.action.label}</button>}
    </div>
  );
}
