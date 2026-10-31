import type { ReactNode } from "react";
import type { RefChip } from "../../lib/gitLogView.ts";
import { parseRefs } from "../../lib/gitLogView.ts";
import { CTRL_H } from "../workspace/Chrome.tsx";
import { DockIcon } from "../GitDock.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { MONO } from "./HistoryFrames.tsx";

const HUE: Record<RefChip["kind"], string> = {
  current: "var(--text)", branch: "var(--text2)", remote: "var(--info)", tag: "var(--warning-ink)",
};
const ICON_OF: Record<RefChip["kind"], string> = { current: "branch", branch: "branch", remote: "cloud", tag: "tag" };

/** One ref, drawn as in the approved Log: a ringed mono chip with the kind's icon, the name clipped last. */
export function RefPill({ hue, icon, title, children }: { hue: string; icon: string; title?: string; children: ReactNode }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 px-1.5 rounded-md min-w-0 text-[11.5px] leading-none"
      style={{ height: CTRL_H.compact, fontFamily: MONO, color: hue, background: "var(--bg)",
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${hue} 24%, transparent)` }}>
      <DockIcon name={icon} size={ICON.xs} />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A row's refs: a chip each, `merge` for a commit with two parents. The cluster is capped so it never covers the subject. */
export function RefChips({ refs, merge, remotes }: { refs?: string; merge?: boolean; remotes?: readonly string[] }) {
  const chips = parseRefs(refs, remotes);
  if (!chips.length && !merge) return null;
  return (
    <span className="chip-ref items-center gap-1.5 shrink-0">
      {merge && <RefPill hue="var(--text3)" icon="merge">merge</RefPill>}
      {chips.map((c) => <RefPill key={`${c.kind}:${c.name}`} hue={HUE[c.kind]} icon={ICON_OF[c.kind]} title={c.name}>{c.name}</RefPill>)}
    </span>
  );
}
