// The panel on the right: what the selected thing is, and its text.
//
// The header says what the selected thing is and what can be done with it; the
// body (PreviewBody) reads it by what it is. The panel never edits: "Open in
// nvim" opens the bench, which is where editing lives.
import { useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { ago } from "../../../lib/fileRecents.ts";
import { TYPE_GROUPS, canEditRow, formatSize, itemsLabel, isFolder, typeGroup, typeLabel, type Row } from "../../../lib/finderMiller.ts";
import { CopyIcon, CrossIcon, TerminalIcon } from "../../../lib/glyphIcons.tsx";
import { StrataIcon } from "./StrataIcon.tsx";
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

export function QuickLook({ path, row, rows, onBench, onCopy, onClose }: {
  path: string | null;
  row: Row | null;
  /** The rows of the folder, when `row` is one: what the summary counts. */
  rows: readonly Row[] | null;
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

  if (!path || !row) {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center p-6 text-center text-[12px]" style={{ color: "var(--text3)" }}>
        Pick something in the columns. Space shows or hides this panel.
      </div>
    );
  }
  const meta = [folder ? itemsLabel(row.items) : row.bytes !== null ? formatSize(row.bytes) : "", `modified ${ago(row.mtime)}`, facts || folder ? typeLabel(folder ? "dir" : facts!.kind, facts?.mime ?? "", row.name) : ""].filter(Boolean).join(" · ");
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col" aria-label={`Preview of ${row.name}`}>
      <div className="px-4 pt-3 pb-2.5 shrink-0" style={{ borderBottom: LINE }}>
        <div className="flex items-start gap-2">
          <h3 className="m-0 flex-1 min-w-0 text-[13px] font-semibold break-all">{row.name}</h3>
          {!row.locked && !folder && (
            <button className="agx-btn rounded-md grid place-items-center shrink-0" style={{ width: HIT - 4, height: HIT - 4, color: "var(--text3)" }} title="Open in the default application" aria-label="Open in the default application"
              onClick={() => { void api.previewOpen(path); }}><StrataIcon set="act" name="external-link" size={ICON.sm} /></button>
          )}
          {onClose && (
            <button className="agx-btn rounded-md grid place-items-center shrink-0" style={{ width: HIT - 4, height: HIT - 4, color: "var(--text3)" }} title="Close the preview (Space)" aria-label="Close the preview" onClick={onClose}><CrossIcon size={ICON.sm} /></button>
          )}
        </div>
        <div className="text-[11px] mt-0.5 break-all" style={{ color: "var(--text3)" }}>
          <span title={new Date(row.mtime).toLocaleString()}>{meta}</span> · {path}
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
      <div className="flex-1 min-h-0 agx-scroll overflow-y-auto overflow-x-hidden px-4 py-3 text-[12px]">
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
          <PreviewBody path={path} facts={facts} canEdit={canEditRow(row)} onBench={() => onBench(path, "edit")} />
        )}
      </div>
    </div>
  );
}
