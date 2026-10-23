// The panel on the right: what the selected thing is, and its text.
//
// The header says what the selected thing is and what can be done with it; the
// body (PreviewBody) reads it by what it is. The panel never edits: "Open in
// nvim" opens the bench, which is where editing lives.
import { useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { ago } from "../../../lib/fileRecents.ts";
import { TYPE_GROUPS, canEditRow, itemsLabel, isFolder, previewMetaLine, typeGroup, type Row } from "../../../lib/finderMiller.ts";
import { CopyIcon, CrossIcon, TerminalIcon } from "../../../lib/glyphIcons.tsx";
import { FileTypeIcon, StrataIcon } from "./StrataIcon.tsx";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import type { FileFacts } from "../../../../../shared/types.ts";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { RevealButton } from "../RevealButton.tsx";
import { PreviewBody } from "./PreviewBody.tsx";

/** A folder's own summary: how many of what, from the rows already read. */
export function folderSummary(rows: readonly Row[]): string[] {
  const n = new Map<string, number>();
  for (const r of rows) { const g = typeGroup(r); n.set(g, (n.get(g) ?? 0) + 1); }
  return TYPE_GROUPS.filter((g) => n.has(g)).map((g) => `${g.toLowerCase()} ${n.get(g)}`);
}

export function QuickLook({ path, row, rows, root, savedTab, onTab, onEditing, onBench, onCopy, onClose }: {
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
  onCopy: (path: string) => void;
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
        <div className="px-4 flex items-center gap-2 shrink-0" style={{ minHeight: 36, borderBottom: LINE }}>
          <h3 className="m-0 flex-1 min-w-0 text-[12px] font-semibold">Preview</h3>
          <span className="grid place-items-center shrink-0 opacity-40" style={{ width: HIT - 4, height: HIT - 4, color: "var(--text3)" }} aria-hidden><StrataIcon set="act" name="external-link" size={ICON.sm} /></span>
          {onClose && (
            <button className="agx-btn rounded-md grid place-items-center shrink-0" style={{ width: HIT - 4, height: HIT - 4, color: "var(--text3)" }} title="Close preview (Space)" aria-label="Close the preview" onClick={onClose}><CrossIcon size={ICON.sm} /></button>
          )}
        </div>
        <div className="flex-1 flex items-center justify-center p-6 text-center text-[12px]" style={{ color: "var(--text3)" }}>No preview for this selection</div>
      </div>
    );
  }
  const meta = previewMetaLine({ folder, bytes: row.bytes, items: row.items, ago: ago(row.mtime), mime: facts?.mime ?? "", name: row.name });
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col" aria-label={`Preview of ${row.name}`}>
      <div className="px-4 pt-3 pb-2.5 shrink-0" style={{ borderBottom: LINE }}>
        <div className="flex items-start gap-2">
          <span className="shrink-0 mt-0.5"><FileTypeIcon name={row.name} isDir={folder} size={20} /></span>
          <h3 className="m-0 flex-1 min-w-0 text-[13px] font-semibold break-all" title={path}>{row.name}</h3>
          {!row.locked && !folder && (
            <button className="agx-btn rounded-md grid place-items-center shrink-0" style={{ width: HIT - 4, height: HIT - 4, color: "var(--text3)" }} title="Open in the default application" aria-label="Open in the default application"
              onClick={() => { void api.previewOpen(path); }}><StrataIcon set="act" name="external-link" size={ICON.sm} /></button>
          )}
          {onClose && (
            <button className="agx-btn rounded-md grid place-items-center shrink-0" style={{ width: HIT - 4, height: HIT - 4, color: "var(--text3)" }} title="Close the preview (Space)" aria-label="Close the preview" onClick={onClose}><CrossIcon size={ICON.sm} /></button>
          )}
        </div>
        <div className="text-[11px] mt-0.5 break-all" style={{ color: "var(--text3)" }}>
          <span title={`${new Date(row.mtime).toLocaleString()} · ${path}`}>{meta}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {row.locked ? null : folder ? (
            <button className="agx-btn inline-flex items-center gap-1.5 px-2.5 rounded-md text-[11.5px]" style={{ minHeight: HIT, background: "var(--text)", color: "var(--bg)" }} onClick={() => onBench(path, "terminal")}>
              <TerminalIcon size={ICON.sm} />Terminal here
            </button>
          ) : !canEditRow(row) ? null : (
            <button className="agx-btn inline-flex items-center gap-1.5 px-2.5 rounded-md text-[11.5px]" style={{ minHeight: HIT, background: "var(--text)", color: "var(--bg)" }} onClick={() => onBench(path, "edit")}>
              Open in nvim <kbd className="text-[10px] opacity-70">⏎</kbd>
            </button>
          )}
          <button className="agx-btn inline-flex items-center gap-1.5 px-2.5 rounded-md text-[11.5px]" style={{ minHeight: HIT, border: EDGE, color: "var(--text2)" }} onClick={() => onCopy(path)}>
            <CopyIcon size={ICON.sm} />Copy path
          </button>
          <RevealButton path={path} what={folder ? "folder" : "file"} />
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col agx-scroll overflow-y-auto overflow-x-hidden px-4 py-3 text-[12px]">
        {row.locked ? (
          <p style={{ color: "var(--text3)" }}>{row.why ?? "Hidden entries are listed by name only; this one is not opened here."}</p>
        ) : folder ? (
          <p style={{ color: "var(--text3)" }}>
            {itemsLabel(row.items)}{rows && rows.length ? ` · ${folderSummary(rows).join(" · ")}` : ""}. → opens it as the next column.
          </p>
        ) : failed ? (
          <p role="alert" style={{ color: "var(--warning-ink)" }}>Not shown: {failed}.</p>
        ) : !facts ? (
          <p style={{ color: "var(--text3)" }}>Reading…</p>
        ) : (
          <PreviewBody path={path} facts={facts} canEdit={canEditRow(row)} root={root} onEditing={onEditing} savedTab={savedTab} onTab={onTab} />
        )}
      </div>
    </div>
  );
}
