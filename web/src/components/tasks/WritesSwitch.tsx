import { LockIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { tipAttr } from "../../lib/tip.ts";
import { Switch } from "../SettingRow.tsx";
import { Button, CTRL_RADIUS, EDGE } from "../workspace/Chrome.tsx";

/** What a board tells the header about its write grant. */
export type BoardWrites = {
  on: boolean;
  /** Forced on by the environment: the switch shows it and cannot turn it off. */
  forced: boolean;
  tracker: string;
  /** The confirmation is open. It is state of the board because a locked field
   *  inside a card opens the same one. */
  asking: boolean;
  ask: (open: boolean) => void;
  set: (on: boolean) => Promise<void>;
};

/** The switch's tooltip. ClickUp's own words stay for ClickUp; no board says "Open a board", and no other tracker's name or variable is shown. */
export function writesTitle(writes: BoardWrites | null): string {
  if (!writes) return "Open a board to change this";
  if (!writes.on) return "Read-only. Turn changes on to move, assign and comment";
  if (!writes.forced) return "Changes to this board are on. Click to turn off";
  return writes.tracker === "ClickUp" ? "Forced on by AGENTGLASS_CLICKUP_WRITE=1" : "Forced on by an environment setting";
}

/** What the confirmation says it unlocks. */
export function writesAsk(tracker: string): string {
  return tracker === "ClickUp"
    ? "Moving a card or assigning yourself fires your workspace's automations and notifies your team. Each change still asks first. There is no undo from here."
    : `${tracker} will be able to move, assign and comment on cards from here. Each change still asks first, it fires your site's automations, and there is no undo from here.`;
}

/**
 * The write switch, in the Tasks header.
 *
 * Fixed width: the label changes between "Read-only" and "Changes on" and a
 * header whose neighbours shift when the state does is a header nobody can aim
 * at. Off the boards it stays where it is, disabled, and says why.
 */
export function WritesSwitch({ writes }: { writes: BoardWrites | null }) {
  const on = !!writes?.on;
  const disabled = !writes || (on && writes.forced);
  const title = writesTitle(writes);
  return (
    <div className="relative shrink-0">
      <button type="button" role="switch" aria-checked={on} disabled={disabled} data-tip={tipAttr(title)} aria-label={title}
        onClick={() => { if (!writes) return; if (on) void writes.set(false); else writes.ask(!writes.asking); }}
        className={`agx-chip w-[140px] h-[28px] inline-flex items-center gap-2 px-2 text-[11px] ${CTRL_RADIUS}`}
        style={{ border: EDGE, color: on ? "var(--text)" : "var(--text3)", opacity: !writes ? 0.45 : 1 }}>
        <Switch on={on} />
        <span className="truncate">{on ? "Changes on" : "Read-only"}</span>
      </button>
      {writes?.asking && (
        /* The popover skin of the list view (.pop): 320 wide, 12 of padding and radius, 8 between its parts. */
        <div role="group" aria-label="Allow changes to this board"
          className="absolute right-0 top-[34px] z-30 flex flex-col text-[11.5px]"
          style={{
            width: 320, padding: 12, gap: 8, borderRadius: 12, background: "var(--bg)", color: "var(--text2)",
            boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent), 0 18px 40px -16px var(--shadow)",
          }}>
          <b className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
            <LockIcon size={ICON.sm} /> Allow changes to this board?
          </b>
          <p className="text-[11px]" style={{ color: "var(--text3)" }}>{writesAsk(writes.tracker)}</p>
          <div className="flex justify-end gap-2">
            <Button tone="quiet" onClick={() => writes.ask(false)}>Not now</Button>
            <Button tone="primary" onClick={() => void writes.set(true)}>Allow changes</Button>
          </div>
        </div>
      )}
    </div>
  );
}
