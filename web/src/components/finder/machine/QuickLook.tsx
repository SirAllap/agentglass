// The panel on the right: what the selected thing is, and its text.
//
// Phase 1 is metadata plus text in a reading view. The colours, rendered
// markdown, PDF and media viewers are phase 2 and are not here — a binary says
// what it is and what it weighs instead of drawing a blank pane. The panel
// never edits: "Open in nvim" opens the bench, which is where editing lives.
import { useEffect, useState } from "react";
import { SERVER, api, withToken } from "../../../lib/api.ts";
import { ago } from "../../../lib/fileRecents.ts";
import { TYPE_GROUPS, canEditRow, itemsLabel, isFolder, typeGroup, type Row } from "../../../lib/finderMiller.ts";
import { humanBytes } from "../../../lib/paletteModel.ts";
import { CopyIcon, TerminalIcon } from "../../../lib/glyphIcons.tsx";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import type { FileFacts } from "../../../../../shared/types.ts";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { RevealButton } from "../RevealButton.tsx";

/** Lines drawn. The rest is one keystroke away in the editor, and 400 wrapped lines is already a screenful. */
export const READ_LINES = 400;

/** A folder's own summary: how many of what, from the rows already read. */
export function folderSummary(rows: readonly Row[]): string[] {
  const n = new Map<string, number>();
  for (const r of rows) { const g = typeGroup(r); n.set(g, (n.get(g) ?? 0) + 1); }
  return TYPE_GROUPS.filter((g) => n.has(g)).map((g) => `${g.toLowerCase()} ${n.get(g)}`);
}

export function QuickLook({ path, row, rows, onBench, onCopy }: {
  path: string | null;
  row: Row | null;
  /** The rows of the folder, when `row` is one: what the summary counts. */
  rows: readonly Row[] | null;
  onBench: (path: string, mode: "edit" | "terminal") => void;
  onCopy: (path: string) => void;
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
  const meta = [folder ? itemsLabel(row.items) : row.bytes !== null ? humanBytes(row.bytes) : "", `modified ${ago(row.mtime)}`].filter(Boolean).join(" · ");
  const lines = facts?.text !== undefined ? facts.text.split("\n") : null;
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col" aria-label={`Preview of ${row.name}`}>
      <div className="px-4 pt-3 pb-2.5 shrink-0" style={{ borderBottom: LINE }}>
        <h3 className="m-0 text-[13px] font-semibold break-all">{row.name}</h3>
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
        ) : facts.kind === "image" ? (
          <>
            <div className="inline-block p-2 rounded-md" style={{ border: EDGE, background: "repeating-conic-gradient(color-mix(in srgb, var(--text) 8%, transparent) 0 25%, transparent 0 50%) 0 0 / 16px 16px" }}>
              <img alt={facts.name} src={withToken(`${SERVER}/preview/raw?path=${encodeURIComponent(path)}`)} style={{ maxWidth: "100%", maxHeight: 340, display: "block" }} />
            </div>
            <p className="mt-2" style={{ color: "var(--text3)" }}>{facts.width && facts.height ? `${facts.width} × ${facts.height} px · ` : ""}{facts.mime}</p>
          </>
        ) : lines ? (
          <>
            <div role="region" aria-label="File text" className="font-mono text-[11.5px] leading-[1.5]">
              {lines.slice(0, READ_LINES).map((l, i) => (
                <div key={i} className="flex min-w-0">
                  <span className="shrink-0 select-none text-right mr-2.5" style={{ width: "3.2em", color: "var(--text4)" }}>{i + 1}</span>
                  <span className="min-w-0" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{l || " "}</span>
                </div>
              ))}
            </div>
            {(lines.length > READ_LINES || facts.textTruncated) && (
              <p className="mt-2" style={{ color: "var(--text3)" }}>First {Math.min(lines.length, READ_LINES)} lines shown. Open in nvim for the rest.</p>
            )}
          </>
        ) : (
          <p style={{ color: "var(--text3)" }}>
            <b>{facts.name}</b> is a {facts.kind === "binary" ? "binary" : facts.kind} file ({humanBytes(facts.bytes)}): no text to show here. Richer viewers come in the next phase.
          </p>
        )}
      </div>
    </div>
  );
}
