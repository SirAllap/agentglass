/*
 * What the Branches tab shows beside the list and instead of it: the inspector
 * of the picked branch, the frame for a repository with one branch, and the
 * name list inside the bulk-delete question.
 */
import type { ReactNode } from "react";
import type { GitBranch, GitWorktree } from "../../../../shared/types.ts";
import { ArrowIcon, BranchIcon, IconLabel } from "../../lib/glyphIcons.tsx";
import { trunkLocalName } from "../../lib/gitBranchList.ts";
import { ICON } from "../../lib/iconSize.ts";
import { Aside, Fact, FrameIcon, InspectorHead, NothingPicked, StateFrame, MONO } from "./HistoryFrames.tsx";
import { Chip, Drift, wash } from "./ui.tsx";
import { CHIP, EDGE } from "../workspace/Chrome.tsx";

/** Two lanes: the trunk's line with what it has that this branch lacks, and the branch forking off with its own commits. */
function DriftCard({ name, trunk, ahead, behind }: { name: string; trunk: string; ahead: number; behind: number }) {
  const dots = (n: number, x0: number, x1: number) => Array.from({ length: Math.min(n, 4) }, (_, i) => x0 + ((i + 1) * (x1 - x0)) / (Math.min(n, 4) + 1));
  return (
    <div className="px-3 py-2.5" style={{ borderRadius: 10, background: wash("--bg3", 45), boxShadow: `inset 0 0 0 1px ${wash("--text", 7)}` }}>
      <svg viewBox="0 0 320 70" className="block w-full h-auto overflow-visible" role="img"
        aria-label={`${ahead} commits only on ${name}, ${behind} only on ${trunk}`}>
        <line x1="10" y1="18" x2="300" y2="18" stroke="var(--text)" strokeWidth="2" />
        <path d="M70 18 C95 18 95 50 120 50 H290" fill="none" stroke="var(--info)" strokeWidth="2" />
        {dots(ahead, 120, 290).map((x) => <circle key={x} cx={x} cy="50" r="4.5" fill="var(--surface-card)" stroke="var(--info)" strokeWidth="2" />)}
        {dots(behind, 70, 300).map((x) => <circle key={x} cx={x} cy="18" r="4.5" fill="var(--surface-card)" stroke="var(--text)" strokeWidth="2" />)}
        <circle cx="70" cy="18" r="3" fill="var(--text)" />
        <text x="10" y="10" fontSize="9.5" fontFamily="ui-monospace, monospace" fill="var(--text2)">{trunk}  ·  {behind ? `${behind} newer commit${behind === 1 ? "" : "s"}` : "nothing newer"}</text>
        <text x="150" y="68" fontSize="9.5" fontFamily="ui-monospace, monospace" fill="var(--info)">{ahead ? `${ahead} commit${ahead === 1 ? "" : "s"} only here` : "nothing only here"}</text>
      </svg>
      <div className="flex items-center gap-1.5 mt-1.5 min-w-0">
        <span className="min-w-0 flex-1 flex items-center gap-1.5">
          <Chip tone="neutral" clip title={name}><IconLabel icon={<BranchIcon size={ICON.xs} />}>{name}</IconLabel></Chip>
          <span className="shrink-0" style={{ color: "var(--text4)" }}><ArrowIcon size={ICON.xs} /></span>
          <Chip title={trunk}><IconLabel icon={<BranchIcon size={ICON.xs} />}>{trunk}</IconLabel></Chip>
        </span>
        <Drift ahead={ahead} behind={behind} />
      </div>
    </div>
  );
}

export function BranchInspector({ branch, track, worktree, root, trunk, isCurrent }: {
  branch?: GitBranch;
  track: { ahead: number; behind: number; gone: boolean };
  worktree?: GitWorktree;
  root: string;
  trunk?: string | null;
  isCurrent: boolean;
}) {
  if (!branch) return <NothingPicked what="a branch" />;
  const there = worktree && worktree.path !== root ? worktree.path : undefined;
  const up = !branch.upstream ? "none yet" : track.gone ? `${branch.upstream} · gone` : [branch.upstream, track.ahead ? `↑${track.ahead} to push` : "", track.behind ? `↓${track.behind} to pull` : ""].filter(Boolean).join(" · ");
  const vs = trunkLocalName(trunk);
  const drifted = branch.aheadTrunk !== undefined && branch.behindTrunk !== undefined && !!vs && branch.name !== vs;
  const sub = [branch.author, branch.date].filter(Boolean).join(" · ");
  return (
    <Aside>
      <InspectorHead icon={<BranchIcon size={ICON.md} />} tone="--info" title={branch.name}
        sub={<>{sub}{branch.upstream && <> · tracks <b style={{ color: "var(--text2)", fontWeight: 600 }}>{branch.upstream}</b></>}</>} />
      {drifted && <DriftCard name={branch.name} trunk={vs!} ahead={branch.aheadTrunk!} behind={branch.behindTrunk!} />}
      <div className="flex flex-col gap-1.5">
        <Fact wide k="Last commit" v={branch.subject} />
        <Fact wide k="Upstream" v={up} mono />
        <Fact wide k="Checkout" v={isCurrent ? "this one" : there ? there : "none — free to switch"} />
        {branch.mergedIntoTrunk !== undefined && trunk && <Fact wide k="Merged" v={branch.mergedIntoTrunk ? `already in ${trunk}` : `not yet in ${trunk}`} />}
      </div>
    </Aside>
  );
}

const BroomIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
    <path d="M9.5 2.5l-3 5M5 7.5l4.5 2.2-1.2 4.3-6-3 2.7-3.5z" />
    <path d="M5.2 11.2l1.1.6M3.3 10.3l.6 1.1" />
  </svg>
);

/** The notice over the list: branches the remote dropped whose work the trunk holds, with the way into Tidy. */
export function GoneBanner({ banner, onReview }: { banner: { bold: string; rest: string }; onReview: () => void }) {
  return (
    <div role="status" className="flex items-center gap-2.5 mt-2 mb-1 px-3 py-2.5 text-[12px] leading-snug"
      style={{ borderRadius: 9, background: wash("--warning", 8), boxShadow: `inset 0 0 0 1px ${wash("--warning", 24)}`, color: "var(--warning-ink)" }}>
      <BroomIcon size={ICON.sm} />
      <span className="min-w-0 flex-1"><b style={{ fontWeight: 600 }}>{banner.bold}</b>{banner.rest}</span>
      <button type="button" onClick={onReview} className={`${CHIP} shrink-0 font-medium`} style={{ color: "var(--text)", border: EDGE }}>
        <IconLabel icon={<BroomIcon size={ICON.xs} />}>Review and clean up</IconLabel>
      </button>
    </div>
  );
}

export function OnlyBranchFrame({ name }: { name: string }) {
  return <StateFrame icon={<FrameIcon icon={<BranchIcon size={ICON.md} />} tone="--text3" />} title={<><span style={{ fontFamily: MONO }}>{name}</span> is the only branch</>}
    text="Type a name above to start one from here. Your changes come with you." />;
}

/** The bulk-delete question's list: every name, one per line, scrolling after eight; the held ones under their own head. */
export function NameList({ can, cannot }: { can: readonly string[]; cannot: readonly string[] }) {
  const box = (names: readonly string[], label: string): ReactNode => !names.length ? null : (
    <div>
      <div className="text-[10px] uppercase tracking-[0.11em] mb-1" style={{ color: "var(--text3)" }}>{label} ({names.length})</div>
      <ul className="agx-scroll m-0 p-0 list-none overflow-y-auto rounded-lg px-2 py-1" style={{ maxHeight: 8 * 20 + 8, background: wash("--text", 5) }}>
        {names.map((n) => <li key={n} className="text-[11px] truncate" style={{ lineHeight: "20px", fontFamily: MONO, color: "var(--text2)" }} title={n}>{n}</li>)}
      </ul>
    </div>
  );
  return <div className="flex flex-col gap-2">{box(can, "Will be deleted")}{box(cannot, "Cannot delete")}</div>;
}
