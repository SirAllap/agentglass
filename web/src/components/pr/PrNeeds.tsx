import type { ReactNode } from "react";
import { Button } from "../workspace/Chrome.tsx";
import { BoltIcon, ClockIcon, CommentIcon, DraftIcon, InfoIcon, LockIcon, MergeIcon, RefreshIcon, UserIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { needsHeading, type Need, type NeedAct, type NeedIcon } from "../../lib/prOverviewBody.ts";
import { PrSection } from "./PrSection.tsx";

const GLYPH: Record<NeedIcon, (s: number) => ReactNode> = {
  merge: (s) => <MergeIcon size={s} />, bolt: (s) => <BoltIcon size={s} />, user: (s) => <UserIcon size={s} />,
  clock: (s) => <ClockIcon size={s} />, update: (s) => <RefreshIcon size={s} />, thread: (s) => <CommentIcon size={s} />,
  lock: (s) => <LockIcon size={s} />, draft: (s) => <DraftIcon size={s} />, info: (s) => <InfoIcon size={s} />,
};

/**
 * "What is in the way": one row per blocker with the button that moves it.
 * Under BP_SIDE the button wraps under the text (CSS, `.prov-need`).
 */
export function PrNeeds({ needs, onAct, busy, pending, disabled }: {
  needs: Need[];
  onAct: (act: NeedAct, e: React.MouseEvent<HTMLButtonElement>) => void;
  busy: boolean;
  /** The act whose request is in flight, so its button spins. */
  pending?: NeedAct;
  /** Acts that cannot run now, with the reason in the button's own label text. */
  disabled?: Partial<Record<NeedAct, string>>;
}) {
  if (!needs.length) return null;
  return (
    <PrSection title={needsHeading(needs)} count={needs.length} testid="pr-needs">
      <div className="prov-needs">
        {needs.map((n) => (
          <div key={n.id} className="prov-need" data-tone={n.tone}>
            <span aria-hidden className="prov-need-i">{GLYPH[n.icon](ICON.md)}</span>
            <span className="prov-need-t">
              <b>{n.lead}</b>
              {n.mono.map((m, i) => <span key={m}>{" "}<span className="prov-mono">{m}</span>{i < n.mono.length - 1 || n.more ? "," : ""}</span>)}
              {n.more > 0 && <span> and {n.more} more.</span>}
              {n.rest && <span> {n.rest}</span>}
            </span>
            {n.act && (
              <Button size="compact" disabled={busy || !!disabled?.[n.act.id]} pending={pending === n.act.id}
                onClick={(e) => onAct(n.act!.id, e)}>{n.act.label}</Button>
            )}
          </div>
        ))}
      </div>
    </PrSection>
  );
}
