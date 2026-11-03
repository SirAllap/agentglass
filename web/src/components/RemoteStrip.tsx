// The strip above the pull request board when the repository is on GitHub only.
//
// Replaces "Showing x on top of y — read-only…" for a `gh:` root: same facts,
// said as what you can do. What needs a checkout is greyed or absent in the
// panel itself (see PrPanel's `readOnly`).
//
// Plain buttons rather than PrPanel's `Btn`: PrPanel imports this file, and a
// module that imports its importer is a cycle the bundler resolves by luck.
import { useMemo, type ReactNode } from "react";
import type { GitRepoRef } from "../../../shared/types.ts";
import { ICON } from "../lib/iconSize.ts";
import { openExternal } from "../lib/externalUrl.ts";
import { requestClone } from "../lib/remoteRepos.ts";
import { EDGE } from "./workspace/Chrome.tsx";
import { RIcon } from "./remoteIcons.tsx";
import { useRemoteTicks } from "./remoteRepoRows.tsx";

/** The ticked GitHub-only repositories as roots the PR panel's repository picker can list. */
export function useRemoteProjects(): GitRepoRef[] {
  const ticks = useRemoteTicks();
  return useMemo(() => ticks.map((t) => ({ root: `gh:${t}`, name: t, branch: "", dirty: 0, ahead: 0, behind: 0, touchedAt: 0 })), [ticks]);
}

const Act = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button onClick={onClick} className="agx-btn text-[11px] px-2.5 py-1 rounded-lg" style={{ color: "var(--text2)", border: EDGE }}>{children}</button>
);

export function RemoteStrip({ repo, backRepo, onBack }: { repo: string; backRepo?: string; onBack?: () => void }) {
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-1.5 shrink-0 text-[11px] border-b" data-remote-strip={repo}
      style={{ borderColor: "color-mix(in srgb, var(--info, #3b82f6) 25%, transparent)", background: "color-mix(in srgb, var(--info, #3b82f6) 7%, transparent)" }}>
      <span className="shrink-0 grid place-items-center rounded-md" style={{ width: 24, height: 24, color: "var(--info, #3b82f6)", background: "color-mix(in srgb, var(--info, #3b82f6) 14%, transparent)" }}>
        <RIcon name="cloud" size={ICON.sm} />
      </span>
      <span className="min-w-0 truncate" style={{ color: "var(--text2)" }} title={`${repo} has no checkout here — merge, branch update, comments and labels work; reviews in a terminal need one`}>
        <b style={{ color: "var(--text)" }}>{repo}</b> has no checkout here — merge, branch update, comments and labels work; reviews in a terminal need one
      </span>
      <span className="shrink-0 inline-flex items-center gap-1 text-[9.5px] px-1.5 py-0.5 rounded-md" style={{ border: EDGE, color: "var(--text2)" }}>
        <RIcon name="eye" size={ICON.xs} />No checkout
      </span>
      <span className="ml-auto shrink-0 flex items-center gap-1.5">
        <Act onClick={() => requestClone(repo)}>Clone to work on it</Act>
        <Act onClick={() => openExternal(`https://github.com/${repo}`)}>GitHub</Act>
        {onBack && <Act onClick={onBack}>Back to {backRepo}</Act>}
      </span>
    </div>
  );
}
