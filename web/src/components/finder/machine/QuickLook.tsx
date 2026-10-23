// The panel on the right: what the selected thing is, and its text.
//
// The header says what the selected thing is and what can be done with it; the
// body (PreviewBody) reads it by what it is. The panel never edits: "Open in
// nvim" opens the bench, which is where editing lives.
import { useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { TYPE_GROUPS, strataWhen, canEditRow, itemsLabel, isFolder, previewMetaLine, typeGroup, type Row } from "../../../lib/finderMiller.ts";
import { FileTypeIcon, StrataIcon } from "./StrataIcon.tsx";
import type { FileFacts } from "../../../../../shared/types.ts";
import { BarButton, PreviewBar } from "./PreviewBar.tsx";
import { PreviewBody } from "./PreviewBody.tsx";

/** A folder's own summary: how many of what, from the rows already read. */
export function folderSummary(rows: readonly Row[]): string[] {
  const n = new Map<string, number>();
  for (const r of rows) { const g = typeGroup(r); n.set(g, (n.get(g) ?? 0) + 1); }
  return TYPE_GROUPS.filter((g) => n.has(g)).map((g) => `${g.toLowerCase()} ${n.get(g)}`);
}

export function QuickLook({ path, row, rows, root, savedTab, onTab, onEditing, onBench, onClose }: {
  path: string | null;
  row: Row | null;
  /** The rows of the folder, when `row` is one: what the summary counts. */
  rows: readonly Row[] | null;
  /** The workspace the Editing tab's nvim session hangs off. */
  root: string;
  savedTab?: { path: string; tab: string };
  onTab: (path: string, tab: string) => void;
  onEditing: (path: string | null) => void;
  onBench: (path: string, mode: "edit" | "terminal") => void;
  /** The panel's own close button: the same as Space, which is how Strata's reads. */
  onClose?: () => void;
}) {
  const [facts, setFacts] = useState<FileFacts | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const folder = !!row && isFolder(row);

  useEffect(() => {
    setFacts(null); setFailed(null);
    if (!path || !row || folder || row.locked) return;
    let live = true;
    void api.previewFacts(path)
      .then((f) => { if (live) { if (f.ok) setFacts(f); else setFailed(f.error ?? "could not be read here"); } })
      .catch(() => { if (live) setFailed("could not be read here"); });
    return () => { live = false; };
  }, [path, row?.name, folder, row?.locked]);

  /* Strata gives a folder no preview: its contents are the next column, and the panel says so. */
  if (!path || !row || isFolder(row)) {
    return (
      <div className="flex-1 min-w-0 min-h-0 flex flex-col" aria-label="Preview">
        <PreviewBar lead={<StrataIcon set="act" name="eye" size={20} />} name={folder && row ? row.name : "Preview"} meta={folder && row ? previewMetaLine({ folder, bytes: null, items: row.items, ago: strataWhen(row.mtime), mime: "", name: row.name }) : ""} onClose={onClose}
          tools={folder && row && !row.locked && path ? <BarButton icon="terminal" label="Terminal here" onClick={() => onBench(path, "terminal")} /> : undefined} />
        <div className="flex-1 flex items-center justify-center p-6 text-center text-[12px]" style={{ color: "var(--text3)" }}>
          {folder && row ? `${itemsLabel(row.items)}${rows && rows.length ? ` · ${folderSummary(rows).join(" · ")}` : ""}. Opens as the next column.` : "No preview for this selection"}
        </div>
      </div>
    );
  }
  const meta = previewMetaLine({ folder, bytes: row.bytes, items: row.items, ago: strataWhen(row.mtime), mime: facts?.mime ?? "", name: row.name });
  const bar = {
    lead: <FileTypeIcon name={row.name} isDir={false} size={20} />, name: row.name, meta, title: path, onClose,
    onOpen: row.locked ? undefined : () => { void api.previewOpen(path); },
    onNvim: canEditRow(row) && !row.locked ? () => onBench(path, "edit") : undefined,
  };
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col" aria-label={`Preview of ${row.name}`}>
      {row.locked ? (
        <>
          <PreviewBar lead={bar.lead} name={bar.name} meta={bar.meta} title={path} onClose={onClose} />
          <div className="flex-1 min-h-0 agx-scroll overflow-y-auto px-4 py-3 text-[12px]"><p style={{ color: "var(--text3)" }}>{row.why ?? "Hidden entries are listed by name only; this one is not opened here."}</p></div>
        </>
      ) : failed || !facts ? (
        <>
          <PreviewBar lead={bar.lead} name={bar.name} meta={bar.meta} title={path} onOpen={bar.onOpen} onClose={onClose} />
          <div className="flex-1 min-h-0 agx-scroll overflow-y-auto px-4 py-3 text-[12px]">
            {failed ? <p role="alert" style={{ color: "var(--warning-ink)" }}>Not shown: {failed}.</p> : <p style={{ color: "var(--text3)" }}>Reading…</p>}
          </div>
        </>
      ) : (
        <PreviewBody path={path} facts={facts} canEdit={canEditRow(row)} root={root} onEditing={onEditing} savedTab={savedTab} onTab={onTab} bar={bar} />
      )}
    </div>
  );
}
