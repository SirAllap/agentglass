/*
 * The tmux sessions quick switcher: the sessions as rows, a way to the bigger
 * dialog, and whose tmux this is.
 *
 * It hangs from the Go list's footer chip. A row switches the strip to that
 * session; the current one wears a dot and the locked ones a padlock. The
 * footer holds what the old prefix and engine chips said (which tmux, which
 * key it listens to, and where to change that); the checkbox that gives tmux
 * its own status line back is offered only on the person's own tmux, because
 * the engine's line is off on purpose.
 */
import { ListIcon, LockIcon, PlusIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { AnchoredMenu } from "../AnchoredMenu.tsx";
import { MenuRow, MenuRule } from "../ContextMenu.tsx";
import { Button, Checkbox, GROUP_HEADING } from "../workspace/Chrome.tsx";
import { GearIcon } from "../workspace/icons.tsx";
import type { RefObject } from "react";

export interface SessionInfo { id: string; name: string; windows: number; locked?: boolean; created?: number }

export function SessionSwitcher({ anchor, current, sessions, engine, prefix, onSwitch, onManage, onUseTmuxBar, onClose }: {
  anchor: RefObject<HTMLElement | null>;
  current: string;
  sessions: readonly SessionInfo[];
  /** This tmux is agentglass's own (the Pane engine), not the machine's. */
  engine: boolean;
  prefix: readonly string[];
  onSwitch: (name: string) => void;
  onManage: () => void;
  /** Give tmux its own status line back. Absent on the engine, which keeps its line off. */
  onUseTmuxBar?: () => void;
  onClose: () => void;
}) {
  return (
    <AnchoredMenu anchor={anchor} align="left" minWidth={288} plain keepTab onClose={onClose}>
      <div className={GROUP_HEADING} style={{ color: "var(--text3)", fontWeight: 600 }}>tmux sessions</div>
      {sessions.map((s) => (
        <MenuRow key={s.id} onClick={() => { onClose(); if (s.name !== current) onSwitch(s.name); }}
          icon={s.name === current ? <span aria-hidden className="rounded-full" style={{ width: 6, height: 6, background: "var(--primary)" }} /> : null}
          hint={s.windows === 1 ? "1 window" : `${s.windows} windows`}
          title={s.locked ? `${s.name} is protected from being ended` : undefined}>
          <span className="inline-flex items-center gap-1.5" style={s.name === current ? { fontWeight: 600, color: "var(--text)" } : undefined}>
            {s.name}{s.locked && <LockIcon size={ICON.xs} />}
          </span>
        </MenuRow>
      ))}
      <MenuRule />
      <MenuRow icon={<ListIcon size={ICON.sm} />} hint="lock, end" onClick={() => { onClose(); onManage(); }}>Manage sessions…</MenuRow>
      <MenuRow icon={<PlusIcon size={ICON.sm} />} disabled title="Creating a session needs a server command that does not exist yet. Manage sessions says how to make one meanwhile." onClick={() => {}}>New session…</MenuRow>
      <MenuRule />
      <div className="px-2.5 py-1.5 flex flex-col gap-1.5 text-[10.5px]" style={{ color: "var(--text3)" }}>
        <div className="flex items-center gap-2">
          <span className="font-semibold" style={{ color: "var(--text)" }} title={engine
            ? "agentglass's own tmux, the Pane engine. Its prefix, config and restore are in Settings, Pane engine."
            : "The tmux on this machine: your ~/.tmux.conf and your bindings. The Pane engine settings do not touch it."}>
            {engine ? "agentglass tmux" : "Your tmux"}
          </span>
          <span>prefix {prefix.length ? prefix.join(" or ") : "unknown"}</span>
          <Button size="compact" tone="quiet" className="ml-auto" onClick={() => { onClose(); openSettings("tmux"); }}><GearIcon size={ICON.xs} />Change</Button>
        </div>
        {onUseTmuxBar && (
          <span title="The strip steps aside so you are never looking at two window lists">
            <Checkbox checked={false} onChange={() => { onClose(); onUseTmuxBar(); }}>Show tmux's own status line</Checkbox>
          </span>
        )}
      </div>
    </AnchoredMenu>
  );
}
