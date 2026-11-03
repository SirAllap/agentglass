/*
 * What the Log's inspector shows under a commit's name: the little graph of its
 * neighbourhood and the files it changed, as the approved Log draws them. The
 * decisions (which dots, how many cells) are in lib/gitLogView.ts.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { GitFileChange, GitGraphLine } from "../../../../shared/types.ts";
import { api } from "../../lib/api.ts";
import { laneColour, type GraphRow } from "../../lib/gitGraph.ts";
import { fileRows, filesTotal, miniCard, type FileRow } from "../../lib/gitLogView.ts";
import { wash } from "./ui.tsx";
import { MONO } from "./HistoryFrames.tsx";

/** The files of a commit, fetched once per commit and kept: arrowing up and down the log asks for each only the first time. */
const FILES = new Map<string, GitFileChange[]>();

export type FilesState = { state: "loading" } | { state: "error" } | { state: "ok"; rows: FileRow[] };

export function useCommitFiles(root: string, hash: string | undefined): FilesState {
  const key = `${root}\0${hash}`;
  const [got, setGot] = useState<{ key: string; changes?: GitFileChange[] } | null>(null);
  useEffect(() => {
    if (!hash || FILES.has(key)) return;
    let live = true;
    api.gitCommitDiff(root, hash)
      .then((r) => { FILES.set(key, r.changes); if (live) setGot({ key, changes: r.changes }); })
      .catch(() => { if (live) setGot({ key }); });
    return () => { live = false; };
  }, [root, hash, key]);
  const cached = FILES.get(key) ?? (got?.key === key ? got.changes : undefined);
  if (cached) return { state: "ok", rows: fileRows(root, cached) };
  return got?.key === key ? { state: "error" } : { state: "loading" };
}

const STATUS_HUE: Record<string, string> = { M: "--warning", A: "--success", D: "--error", R: "--info" };

function Cap({ children, small }: { children: ReactNode; small?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide pt-0.5" style={{ color: "var(--text3)" }}>
      {children}{small && <small className="font-normal normal-case" style={{ fontFamily: MONO, color: "var(--text4)" }}>{small}</small>}
      <span aria-hidden className="flex-1 h-px" style={{ background: wash("--text", 7) }} />
    </div>
  );
}

export function FilesBlock({ files }: { files: FilesState }) {
  if (files.state === "loading") return <Cap>Files</Cap>;
  if (files.state === "error") return <><Cap>Files</Cap><div className="text-[11px]" style={{ color: "var(--text3)" }}>The files of this commit could not be read.</div></>;
  const t = filesTotal(files.rows);
  return (
    <>
      <Cap small={`${t.files} · +${t.add} −${t.del}`}>Files</Cap>
      <div data-files>
        {files.rows.map((f, i) => {
          const hue = STATUS_HUE[f.status];
          return (
            <div key={i} className="grid items-center gap-2 min-h-[24px] text-[11.5px]" style={{ gridTemplateColumns: "18px minmax(0, 1fr) auto", fontFamily: MONO, color: "var(--text2)" }}>
              <span className="grid place-items-center font-semibold text-[10px]" title={f.status}
                style={{ width: 18, height: 18, borderRadius: 5, color: hue ? `var(${hue})` : "var(--text3)", background: wash(hue ?? "--text", 10), boxShadow: `inset 0 0 0 1px ${wash(hue ?? "--text", 30)}` }}>{f.status}</span>
              <span className="truncate text-left" title={f.dir + f.name} style={{ direction: "rtl" }}>
                <bdi style={{ direction: "ltr" }}><span style={{ color: "var(--text4)" }}>{f.dir}</span>{f.name}</bdi>
              </span>
              <span className="inline-flex gap-px" aria-label={`${f.add} added, ${f.del} deleted`}>
                {f.cells.map((c, k) => (
                  <i key={k} style={{ width: 5, height: 8, borderRadius: 1, background: c === "a" ? "var(--success)" : c === "r" ? "var(--error)" : "var(--bg3)" }} />
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** The selected commit and the commits around it: lanes as tracks, old to new, the cursor's dot ringed. */
export function MiniCard({ lines, layout, hash }: { lines: readonly GitGraphLine[]; layout: ReadonlyMap<string, GraphRow>; hash: string }) {
  const m = miniCard(lines, layout, hash);
  if (!m) return null;
  const bend = (e: { x1: number; y1: number; x2: number; y2: number }) => {
    const mid = (e.x1 + e.x2) / 2;
    return e.y1 === e.y2 ? `M${e.x1} ${e.y1} H${e.x2}` : `M${e.x1} ${e.y1} C${mid} ${e.y1} ${mid} ${e.y2} ${e.x2} ${e.y2}`;
  };
  return (
    <div data-mini-card className="rounded-xl" style={{
      padding: "10px 12px", background: "linear-gradient(180deg, color-mix(in srgb, var(--bg2) 70%, var(--bg)), var(--bg2))",
      boxShadow: `inset 0 0 0 1px ${wash("--text", 7)}` }}>
      <svg viewBox={`0 0 ${m.w} ${m.h}`} width="100%" role="img" aria-label="The commits around this one" style={{ display: "block", overflow: "visible", height: "auto" }}>
        {m.edges.map((e, i) => <path key={i} d={bend(e)} fill="none" stroke={laneColour(e.lane)} strokeWidth={2} />)}
        {m.dots.map((d) => (
          <circle key={d.hash} cx={d.x} cy={d.y} r={d.sel ? 6 : 4.5} fill="var(--bg)" stroke={d.sel ? "var(--primary)" : laneColour(d.lane)} strokeWidth={d.sel ? 2.4 : 2} />
        ))}
        {m.labels.map((l) => (
          <text key={l.lane} x={l.x} y={l.y} fontSize={9.5} fontFamily="ui-monospace, monospace" fill={l.lane === 0 ? "var(--text3)" : laneColour(l.lane)}>{l.text}</text>
        ))}
      </svg>
    </div>
  );
}
