/*
 * What the Stashes tab shows beside the list: what is in the picked stash, and
 * a warning when applying it would meet the same files in the working tree or
 * when the last apply stopped on a clash.
 */
import type { GitStash, GitStashFile } from "../../../../shared/types.ts";
import { Button } from "../workspace/Chrome.tsx";
import { StashIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Aside, InspectorHead, MONO, NothingPicked, StateFrame } from "./HistoryFrames.tsx";
import { wash, inkOver } from "./ui.tsx";

/** Files the stash and the working tree both changed: applying merges both. */
export const stashOverlap = (files: readonly GitStashFile[], treeRels: ReadonlySet<string>): string[] =>
  files.filter((f) => treeRels.has(f.path)).map((f) => f.path);

const STATUS_TONE: Record<string, string> = { A: "--success", D: "--error", M: "--warning" };

export type StashFiles = readonly GitStashFile[] | "loading" | "failed";

export function StashInspector({ stash, files, overlap, clashPaths, onRetry }: {
  stash?: GitStash; files: StashFiles; overlap: readonly string[]; clashPaths: readonly string[]; onRetry: () => void;
}) {
  if (!stash) return <NothingPicked what="a stash" />;
  const [, branch, label] = /^(?:WIP on|On) ([^:]+): (.*)$/i.exec(stash.message) ?? [];
  return (
    <Aside>
      <InspectorHead icon={<StashIcon size={ICON.md} />} tone="--primary" title={label || stash.message}
        sub={<><span style={{ fontFamily: MONO }}>{stash.ref}</span>{branch ? ` · made on ${branch}` : ""}</>} />
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>
          What is in it{Array.isArray(files) ? ` · ${files.length}` : ""}
        </div>
        {files === "loading" && <div className="text-[11px]" style={{ color: "var(--text3)" }}>Reading the stash…</div>}
        {files === "failed" && (
          <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--text2)" }}>
            Could not read its files.<Button onClick={onRetry}>Try again</Button>
          </div>
        )}
        {Array.isArray(files) && !files.length && <div className="text-[11px]" style={{ color: "var(--text3)" }}>No tracked files. It holds only new files.</div>}
        {Array.isArray(files) && (files as readonly GitStashFile[]).map((f) => (
          <div key={f.path} className="flex items-center gap-2 min-w-0 text-[11px]">
            <span className="shrink-0 grid place-items-center rounded text-[10px] font-semibold" aria-label={f.status}
              style={{ width: 18, height: 18, color: STATUS_TONE[f.status] ? inkOver(STATUS_TONE[f.status]) : "var(--text3)", background: wash(STATUS_TONE[f.status] ?? "--text", 14) }}>{f.status}</span>
            <span className="min-w-0 break-all" title={f.path} style={{ fontFamily: MONO, color: "var(--text2)" }}>{f.path}</span>
          </div>
        ))}
      </div>
      {(clashPaths.length > 0 || overlap.length > 0) && (
        <div className="flex items-start gap-2 text-[11.5px] leading-relaxed px-3 py-2 rounded-lg" role="status"
          style={{ color: "var(--text2)", background: wash("--warning", 12) }}>
          <span className="shrink-0 mt-0.5" style={{ color: "var(--warning-ink)" }}><WarningIcon size={ICON.sm} /></span>
          {clashPaths.length > 0
            ? <span><b>The last apply stopped on {clashPaths.length === 1 ? clashPaths[0] : `${clashPaths.length} files`}.</b> Resolve the conflict, or put your tree back.</span>
            : <span><b>{overlap.length === 1 ? overlap[0] : `${overlap.length} of these files`}</b> also changed in your tree. Applying merges both; a clash opens the conflict view.</span>}
        </div>
      )}
    </Aside>
  );
}

export function NoStashesFrame() {
  return <StateFrame title="No stashes" text="A stash sets uncommitted work aside so the tree is clean. Use Stash all changes to make one." />;
}
