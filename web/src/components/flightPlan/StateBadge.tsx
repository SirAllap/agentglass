import type { ReactNode } from "react";
import type { StateBadge, StateIcon } from "../../lib/flightPilot.ts";
import { DoneIcon, FlagIcon, StarIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { AskIcon, BellIcon, ClockIcon, EyeIcon, LockIcon, MergeIcon, PauseIcon, PenIcon, PlaneIcon, ShieldIcon, StopIcon, TickIcon } from "./fpIcons.tsx";

const GLYPH: Record<StateIcon, (p: { size?: number }) => ReactNode> = {
  pen: PenIcon, eye: EyeIcon, star: StarIcon, ask: AskIcon, flag: FlagIcon, clock: ClockIcon, plane: PlaneIcon, bell: BellIcon,
  pause: PauseIcon, stop: StopIcon, check: TickIcon, merge: MergeIcon, done: DoneIcon, lock: LockIcon, shield: ShieldIcon,
};
export const StateGlyph = ({ icon, size = ICON.sm }: { icon: StateIcon; size?: number }) => GLYPH[icon]({ size });

/**
 * A flight's situation as a tile: the icon and the word say it, the hue only repeats who is next.
 * Solid and pulsing only while real work runs (Writing, In Preflight, Building, Checking); every other state is hollow and dashed.
 */
export function StateTile({ state, detail = false }: { state: StateBadge; detail?: boolean }) {
  return (
    <div className="pv-state" data-state-id={state.id} data-tone={state.tone} data-running={state.running ? "" : undefined} data-detail={detail ? "" : undefined} title={state.long}>
      <span className="st-ico" aria-hidden="true"><StateGlyph icon={state.icon} size={detail ? ICON.lg : ICON.sm} /></span>
      <span className="w">{detail ? state.long : state.word}</span>
      {!detail && state.sub && <span className="s">{state.sub}</span>}
    </div>
  );
}
