/*
 * The strip's "+": what you can start from here.
 *
 * A new shell (the same as the chord), a new agent, an old agent session to
 * resume, and a split of the window on screen. It is one menu instead of four
 * buttons so the strip carries one control for "make something", and every
 * start that used to be reachable (the + itself, Sessions, the no-tmux Split)
 * is a row in it.
 *
 * The Resume list is drawn by ResumeSessions and hangs from this button; the
 * "terminal.resume" request an agent can send (lib/viewModalIntent.ts) is
 * answered here, because this is what is mounted when it arrives.
 */
import { useEffect, useRef, useState } from "react";
import type { AgentSessionRow } from "../../../../shared/types.ts";
import { AgentIcon, GridIcon, PlusIcon, TerminalIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { appChordFor, chordLabel } from "../../lib/keybindings.ts";
import { subscribeViewModal, takeViewModal } from "../../lib/viewModalIntent.ts";
import { AnchoredMenu } from "../AnchoredMenu.tsx";
import { MenuRow, MenuRule } from "../ContextMenu.tsx";
import { ResumeSessions } from "../ResumeSessions.tsx";
import { Button, GROUP_HEADING } from "../workspace/Chrome.tsx";

export interface PlusProps {
  root: string;
  /** The terminal is off or still starting: nothing here can start anything. */
  disabled?: boolean;
  /** The words of the button's tooltip. */
  title: string;
  newShell: () => void;
  newAgent: () => void;
  /** Null when there is nothing to split; `splitWhy` says why, in the row's tooltip. */
  split: (() => void) | null;
  splitWhy?: string;
  /** Resume needs tmux (it opens a window or a split of its own). */
  canResume: boolean;
  onResume: (s: AgentSessionRow, how: { split: boolean; yolo: boolean }) => void;
  onGo: (at: NonNullable<AgentSessionRow["openIn"]>) => void;
}

export function PlusButton(p: PlusProps) {
  const box = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [resume, setResume] = useState(false);

  useEffect(() => {
    const run = () => { if (p.canResume && takeViewModal("terminal.resume")) setResume(true); };
    run();
    return subscribeViewModal(run);
  }, [p.canResume]);

  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  return (
    <span ref={box} className="relative shrink-0 inline-flex">
      <Button size="strip" tone="quiet" square label="New window" title={p.title} disabled={p.disabled}
        aria-haspopup="menu" aria-expanded={open} on={open || undefined}
        onClick={() => setOpen((o) => !o)}>
        <PlusIcon size={ICON.sm} />
      </Button>
      {open && (
        <AnchoredMenu anchor={box} align="left" minWidth={250} plain onClose={() => setOpen(false)}>
          <div className={GROUP_HEADING} style={{ color: "var(--text3)", fontWeight: 600 }}>New window</div>
          <MenuRow icon={<TerminalIcon size={ICON.sm} />} kbd={chordLabel(appChordFor("terminal.newshell"))} onClick={pick(p.newShell)}>New shell</MenuRow>
          <MenuRow icon={<AgentIcon size={ICON.sm} />} onClick={pick(p.newAgent)}>New agent (Claude Code)</MenuRow>
          <MenuRow icon={<ResumeIcon />} disabled={!p.canResume} title={p.canResume ? "Resume a past agent session from this project, in any of its checkouts" : "Resuming opens a tmux window, and this terminal is not in tmux"}
            onClick={pick(() => setResume(true))}>Resume a session…</MenuRow>
          <MenuRule />
          <MenuRow icon={<GridIcon size={ICON.sm} />} disabled={!p.split} title={p.split ? "Show another pane beside this one" : p.splitWhy} onClick={pick(p.split ?? (() => {}))}>Split this window</MenuRow>
          <MenuRule />
          <div className="px-2 pt-1 pb-1.5 text-[10.5px]" style={{ color: "var(--text3)" }}>New windows are named after the folder, like the rest.</div>
        </AnchoredMenu>
      )}
      <ResumeSessions root={p.root} open={resume} anchor={box} onClose={() => setResume(false)} onOpen={p.onResume} onGo={p.onGo} />
    </span>
  );
}

/** The arrow that turns back, with a clock hand: the same drawing the old Sessions button had. */
function ResumeIcon() {
  return (
    <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" /><path d="M2.4 2.6v3h3" /><path d="M8 5.2V8l2 1.4" />
    </svg>
  );
}
