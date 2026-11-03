/*
 * The "..." menus: one container's, one stack's. The items come from
 * `menuItems` and `groupMenu` (dockerState.ts), which decide what a state and
 * a read-only instance may offer; this only draws them on the anchored menu.
 */
import type { ReactNode, RefObject } from "react";
import type { DockerContainer } from "../../../../shared/types.ts";
import { groupMenu, menuItems, type MenuItem } from "../../lib/dockerState.ts";
import { FileIcon, InfoIcon, LinkIcon, PlayIcon, RefreshIcon, TerminalIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { AnchoredMenu } from "../AnchoredMenu.tsx";
import { TrashIcon } from "./DockerIcons.tsx";

const Stop = () => <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 14 14" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5" /></svg>;

const ICON_OF: Record<string, ReactNode> = {
  logs: <FileIcon size={ICON.sm} />, insp: <InfoIcon size={ICON.sm} />, shell: <TerminalIcon size={ICON.sm} />,
  open: <LinkIcon size={ICON.sm} />, unpause: <PlayIcon size={ICON.xs} />, stop: <Stop />, rm: <TrashIcon size={ICON.sm} />,
};

export function Item({ icon, label, kbd, disabled, reason, danger, onClick }: {
  icon: ReactNode; label: string; kbd?: string; disabled?: boolean; reason?: string; danger?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" role="menuitem" className="dk-mi" disabled={disabled} title={reason} data-danger={danger || undefined} onClick={onClick}>
      {icon}<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>{kbd ? <span className="r"><kbd>{kbd}</kbd></span> : null}
    </button>
  );
}

export function RowMenu({ anchor, c, where, readOnly, onPick, onClose }: {
  anchor: RefObject<HTMLElement | null>; c: DockerContainer; where: "row" | "detail"; readOnly: boolean;
  onPick: (verb: MenuItem["verb"]) => void; onClose: () => void;
}) {
  return (
    <AnchoredMenu anchor={anchor} minWidth={206} onClose={onClose}>
      {menuItems(c, { where, readOnly }).map((m, i) => m.verb === "hr"
        ? <div key={i} className="dk-hr" />
        : <Item key={m.verb} icon={ICON_OF[m.verb]} label={m.label} kbd={m.key} disabled={m.disabled} reason={m.reason} danger={m.danger}
          onClick={() => { onClose(); onPick(m.verb); }} />)}
    </AnchoredMenu>
  );
}

export type GroupPick = "start" | "restart" | "stop";

export function GroupMenu({ anchor, cs, readOnly, onPick, onClose }: {
  anchor: RefObject<HTMLElement | null>; cs: DockerContainer[]; readOnly: boolean;
  onPick: (verb: GroupPick, ids: string[]) => void; onClose: () => void;
}) {
  const g = groupMenu(cs, { readOnly });
  const row = (verb: GroupPick, icon: ReactNode, danger?: boolean) => (
    <Item icon={icon} label={g[verb].label} disabled={g[verb].disabled} reason={g[verb].reason} danger={danger}
      onClick={() => { onClose(); onPick(verb, g[verb].ids); }} />
  );
  return (
    <AnchoredMenu anchor={anchor} minWidth={206} onClose={onClose}>
      {row("start", <PlayIcon size={ICON.xs} />)}
      {row("restart", <RefreshIcon size={ICON.sm} />)}
      <div className="dk-hr" />
      {row("stop", <Stop />, true)}
    </AnchoredMenu>
  );
}
