/*
 * What the Worktrees tab shows beside the list. The pid callout exists only
 * when the server found a process inside the folder: off Linux it never does,
 * and nothing is drawn rather than a blank.
 */
import type { GitWorktree } from "../../../../shared/types.ts";
import { FolderIcon, TerminalIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Aside, Fact, InspectorHead, NothingPicked } from "./HistoryFrames.tsx";
import { wash } from "./ui.tsx";

export function WorktreeInspector({ wt }: { wt?: GitWorktree }) {
  if (!wt) return <NothingPicked what="a worktree" />;
  const name = wt.path.split("/").pop() || wt.path;
  return (
    <Aside>
      <InspectorHead icon={<FolderIcon size={ICON.md} />} tone={wt.current ? "--primary" : "--warning"} title={name}
        sub={<>on <b style={{ color: "var(--text2)" }}>{wt.branch}</b> · {wt.head}</>} />
      {wt.busy && (
        <div className="flex items-start gap-2 text-[11.5px] leading-relaxed px-3 py-2 rounded-lg" role="status"
          style={{ color: "var(--text2)", background: wash("--warning", 12) }}>
          <span className="shrink-0 mt-0.5" style={{ color: "var(--warning-ink)" }}><TerminalIcon size={ICON.sm} /></span>
          <span><b>Something is running inside</b>{wt.pid ? ` (pid ${wt.pid})` : ""}. Removing the folder now leaves it with no working directory.</span>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Fact wide mono k="Path" v={wt.path} />
        <Fact wide k="Changes" v={wt.dirty === undefined ? undefined : wt.dirty ? `${wt.dirty} changed` : "none"} />
        <Fact wide k="Behind" v={wt.behindBase ? `${wt.behindBase} behind ${wt.base ?? "its base"}` : undefined} />
        <Fact wide k="Locked" v={wt.locked ? "yes: unlock it before removing" : undefined} />
        <Fact wide k="Registration" v={wt.prunable ? "broken: its folder is gone" : undefined} />
      </div>
    </Aside>
  );
}
