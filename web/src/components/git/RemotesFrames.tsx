/*
 * What the Remotes tab shows beside the list and instead of it: the inspector
 * of the picked remote branch, and the frame for a repository with no remote.
 */
import type { GitRemote, GitRemoteBranch } from "../../../../shared/types.ts";
import { Button } from "../workspace/Chrome.tsx";
import { CopyIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { DockIcon } from "../GitDock.tsx";
import { Aside, Fact, InspectorHead, NothingPicked, StateFrame } from "./HistoryFrames.tsx";
import { wash } from "./ui.tsx";

export function RemoteBranchInspector({ branch, remote, current, root }: {
  branch?: GitRemoteBranch; remote: string; current?: string; root: string;
}) {
  if (!branch) return <NothingPicked what="a remote branch" />;
  const there = branch.worktree && branch.worktree !== root ? branch.worktree : undefined;
  const sub = [branch.author, branch.date, branch.local ? undefined : "not on this computer yet"].filter(Boolean).join(" · ");
  return (
    <Aside>
      <InspectorHead icon={<DockIcon name="cloud" />} tone="--info" title={branch.ref} sub={sub} />
      {!branch.local && !there && (
        <div className="text-[11px] leading-relaxed px-3 py-2 rounded-lg" style={{ color: "var(--text2)", background: wash("--info", 8) }}>
          <b>Bring it local, stay here</b> makes <code>{branch.name}</code>{current ? <> without leaving <b>{current}</b></> : null}. <b>Own folder</b> puts it in a folder beside this one.
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Fact wide k="Remote" v={remote} mono />
        <Fact wide k="Last commit" v={branch.subject} />
        <Fact wide k="Local copy" v={there ? `in ${there}` : branch.local ? (branch.tracking ? "yes, tracking it" : "yes, same name") : "none"} />
      </div>
    </Aside>
  );
}

const ADD = "git remote add origin <url>";

/** No remote at all: nothing to list, and the one command that makes one. */
export function NoRemoteFrame({ copy }: { copy: (text: string) => void }) {
  return (
    <StateFrame title="This repository has no remote"
      text="Everything lives on this computer only. Add one with git, and its branches show up here."
      code={ADD}
      actions={<Button onClick={() => copy(ADD)}><CopyIcon size={ICON.sm} />Copy the command</Button>} />
  );
}

/** The line next to Fetch: where this remote points, and where it pushes when that differs. */
export const remoteUrlLine = (r?: GitRemote) => r ? (r.pushUrl && r.pushUrl !== r.fetchUrl ? `${r.fetchUrl} · pushes to ${r.pushUrl}` : r.fetchUrl) : "";
