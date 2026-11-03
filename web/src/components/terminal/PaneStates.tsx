/*
 * What the pane area says when there is no window to show, as cards on the
 * pane layer: nothing running, connecting, tmux unreachable, and (a note, not a
 * card) no tmux at all. Which one is on screen is a tested decision
 * (lib/termStates.ts); this is the drawing.
 */
import { useRef, useState } from "react";
import type { AgentSessionRow } from "../../../../shared/types.ts";
import { AgentIcon, ClockIcon, TerminalIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { LAYER } from "../../lib/layers.ts";
import { ResumeSessions } from "../ResumeSessions.tsx";
import { Button, EDGE, tintEdge } from "../workspace/Chrome.tsx";
import { IconTile, PaneCard, PaneSheet } from "./PaneCard.tsx";

/** Three bars where the tabs will be, so the strip does not jump when they arrive. */
export function SkeletonTabs({ still = false }: { still?: boolean }) {
  return (
    <div aria-hidden className="flex items-center gap-1.5" style={{ opacity: still ? 0.6 : 1 }}>
      {[90, 70, 110].map((w) => (
        <i key={w} className={`block rounded-lg ${still ? "" : "agx-skel"}`} style={{ width: w, height: 20, background: "var(--bg3)" }} />
      ))}
    </div>
  );
}

export function LoadingCard({ session }: { session: string | null }) {
  return (
    <PaneSheet veil={0}>
      <PaneCard role="status" late tint="var(--primary)" icon={<span className="animate-pulse motion-reduce:animate-none"><TerminalIcon size={ICON.md} /></span>}
        title="Connecting to tmux">
        {session ? `Reading windows from ${session}…` : "Reading windows…"}
      </PaneCard>
    </PaneSheet>
  );
}

export function ErrorCard({ socket, onRetry, onSettings }: { socket: string | null; onRetry: () => void; onSettings: () => void }) {
  return (
    <PaneSheet veil={0}>
      <PaneCard role="alert" tint="var(--error)" icon={<WarningIcon size={ICON.md} />} title="Can't reach tmux"
        actions={<>
          <Button tone="primary" onClick={onRetry}>Try again</Button>
          <Button tone="plain" onClick={onSettings}>Open Terminal settings</Button>
        </>}>
        {socket ? <>Nothing answered on <span className="font-mono break-all" style={{ color: "var(--text)" }}>{socket}</span>. </> : "Nothing answered. "}
        The server may be restarting, or tmux was stopped. Your windows are kept by tmux and will be there when it is back.
      </PaneCard>
    </PaneSheet>
  );
}

function Tile({ icon, title, sub, onClick, tileRef }: {
  icon: React.ReactNode; title: string; sub: string; onClick: () => void; tileRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button ref={tileRef} type="button" onClick={onClick}
      className="flex flex-col items-start gap-2 text-left rounded-xl p-3 transition-[background-color,transform] duration-150 hover:bg-[var(--surface-inset)] active:scale-[0.98] motion-reduce:transition-none"
      style={{ width: 160, border: EDGE, background: "var(--surface-card)", color: "var(--text)" }}>
      <IconTile tint="var(--primary)" size={32}>{icon}</IconTile>
      <span className="text-[12px] font-semibold">{title}</span>
      <span className="text-[11px] leading-snug" style={{ color: "var(--text3)" }}>{sub}</span>
    </button>
  );
}

export function EmptyCard({ session, root, canResume, onShell, onAgent, onResume, onGo }: {
  session: string | null;
  root: string;
  canResume: boolean;
  onShell: () => void;
  onAgent: () => void;
  onResume: (s: AgentSessionRow, how: { split: boolean; yolo: boolean }) => void;
  onGo: (at: NonNullable<AgentSessionRow["openIn"]>) => void;
}) {
  const resumeTile = useRef<HTMLButtonElement>(null);
  const [resume, setResume] = useState(false);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-4" style={{ zIndex: LAYER.pane }}>
      <div className="agx-card-in flex flex-col items-center gap-2 text-center">
        <IconTile tint="var(--text3)" size={44}><TerminalIcon size={ICON.lg} /></IconTile>
        <h3 className="m-0 text-[14px] font-semibold" style={{ color: "var(--text)" }}>{session ? `Nothing running in ${session}` : "Nothing running"}</h3>
        <p className="m-0 text-[12px]" style={{ color: "var(--text3)" }}>Windows live in tmux, so they survive closing the app and a restart.</p>
      </div>
      <div className="agx-card-in flex flex-wrap justify-center gap-2.5">
        <Tile icon={<TerminalIcon size={ICON.md} />} title="New shell" sub="A plain shell in this project" onClick={onShell} />
        <Tile icon={<AgentIcon size={ICON.md} />} title="New agent" sub="Start an agent in a window" onClick={onAgent} />
        {canResume && <Tile tileRef={resumeTile} icon={<ClockIcon size={ICON.md} />} title="Resume a session" sub="Pick up an earlier conversation" onClick={() => setResume(true)} />}
      </div>
      <ResumeSessions root={root} open={resume} anchor={resumeTile} onClose={() => setResume(false)} onOpen={onResume} onGo={onGo} />
    </div>
  );
}

/** No tmux on this machine: the shell still works, and says what it costs. */
export function NoTmuxNote({ onInstall, onDismiss }: { onInstall: () => void; onDismiss: () => void }) {
  return (
    <div role="note" className="absolute flex items-center gap-2 rounded-xl pl-3 pr-2 py-1.5"
      style={{
        left: 12, right: 68, bottom: 52, zIndex: LAYER.pane, color: "var(--text2)",
        background: "color-mix(in srgb, var(--error) 6%, var(--bg))", border: tintEdge("var(--error)", 28),
      }}>
      <span aria-hidden className="shrink-0" style={{ color: "var(--error)" }}><WarningIcon size={ICON.sm} /></span>
      <span className="min-w-0 flex-1 text-[12px] leading-snug">No tmux. Install it to keep windows after a restart.</span>
      <Button size="compact" tone="plain" onClick={onInstall}>How to install</Button>
      <Button size="compact" tone="quiet" onClick={onDismiss}>Dismiss</Button>
    </div>
  );
}
