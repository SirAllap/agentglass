/*
 * Everything the Terminal puts over the pane that is not the shell: the
 * restore banner, the card of the window in front (resume or dead), the close
 * question and its toast, and the state cards (connecting, can't reach tmux,
 * nothing running, no tmux). The decisions are tested modules (lib/restoreCards,
 * closeRules, termStates); this wires them to the tmux door and the pane.
 *
 * Rendered inside the pane area, on the pane layer, so the strip's tabs, the
 * gear and Commands stay reachable beneath every card.
 */
import { useEffect, useState } from "react";
import type { AgentSessionRow, TmuxWindow } from "../../../../shared/types.ts";
import { AgentIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { checkoutOf } from "../../lib/windowSwitcher.ts";
import { paneCard, restoredBanner } from "../../lib/restoreCards.ts";
import type { TermState } from "../../lib/termStates.ts";
import type { TmuxCmdBody } from "../../lib/tmuxCmd.ts";
import type { WindowCloser } from "../../lib/useWindowClose.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { Button } from "../workspace/Chrome.tsx";
import { CloseConfirm, ReopenToast } from "./CloseLayer.tsx";
import { PaneCard, PaneSheet } from "./PaneCard.tsx";
import { EmptyCard, ErrorCard, LoadingCard, NoTmuxNote } from "./PaneStates.tsx";
import { RestoreBannerPill } from "./RestoreBanner.tsx";

const BANNER_KEY = "agentglass-restore-banner";
const NOTE_KEY = "agentglass-no-tmux-note";
const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode: it comes back next load */ } };

/** Whether the person already put the no-tmux note away. */
export const noTmuxNoteDismissed = (): boolean => read(NOTE_KEY) === "off";

export interface TermOverlaysProps {
  state: TermState;
  windows: readonly TmuxWindow[];
  active: string | null;
  session: string | null;
  socket: string | null;
  root: string;
  canResume: boolean;
  cmd: (body: TmuxCmdBody) => void;
  closer: WindowCloser;
  onRetry: () => void;
  onShell: () => void;
  onAgent: () => void;
  onResume: (s: AgentSessionRow, how: { split: boolean; yolo: boolean }) => void;
  onGo: (at: NonNullable<AgentSessionRow["openIn"]>) => void;
  onNoteDismissed: () => void;
}

export function TermOverlays(p: TermOverlaysProps) {
  const { windows, cmd, closer } = p;
  const banner = restoredBanner(windows);
  const [hiddenStamp, setHiddenStamp] = useState<string | null>(() => read(BANNER_KEY));
  const bannerOn = !!banner && hiddenStamp !== String(banner.stamp);
  const win = windows.find((w) => w.id === p.active) ?? null;

  // Once the banner is put away, a restored shell that is in front has been
  // seen: its quiet mark goes (the server forgets it, so a reload keeps it gone).
  useEffect(() => {
    if (banner && !bannerOn && win?.restored && !win.was) cmd({ cmd: "restored", how: "dismiss", window: win.id });
  }, [banner, bannerOn, win?.id, win?.restored, win?.was, cmd]);

  const notNow = () => { if (banner) { write(BANNER_KEY, String(banner.stamp)); setHiddenStamp(String(banner.stamp)); } };
  const tabOf = (id: string) => document.querySelector(`[data-window="${id}"]`);
  const where = win ? checkoutOf(win.repo, win.cwd ?? "") || (win.cwd ?? "").split("/").filter(Boolean).pop() || null : null;
  const card = win ? paneCard(win, where, Date.now()) : null;

  return (
    <>
      {bannerOn && banner && (
        <RestoreBannerPill banner={banner}
          onResumeAll={() => { cmd({ cmd: "restored", how: "resume" }); notNow(); }}
          onNotNow={notNow} />
      )}
      {win && card && (
        <PaneSheet veil={card.kind === "dead" ? 24 : 40}>
          {card.kind === "dead" ? (
            <PaneCard role="alert" tint="var(--error)" icon={<WarningIcon size={ICON.md} />} title={card.title}
              actions={<>
                <Button tone="primary" onClick={() => cmd({ cmd: "restart", window: win.id })}>{card.primary}</Button>
                <Button tone="plain" onClick={() => closer.request([win.id], { anchor: tabOf(win.id) })}>{card.secondary}</Button>
              </>}>
              {card.body}
            </PaneCard>
          ) : (
            <PaneCard role="group" tint="var(--primary)" icon={<AgentIcon size={ICON.md} />} title={card.title}
              actions={<>
                <Button tone="primary" onClick={() => cmd({ cmd: "restored", how: "resume", window: win.id })}>{card.primary}</Button>
                <Button tone="plain" onClick={() => cmd({ cmd: "restored", how: "dismiss", window: win.id })}>{card.secondary}</Button>
              </>}>
              {card.body}
            </PaneCard>
          )}
        </PaneSheet>
      )}
      {p.state === "loading" && <LoadingCard session={p.session} />}
      {p.state === "error" && <ErrorCard socket={p.socket} onRetry={p.onRetry} onSettings={() => openSettings("terminal")} />}
      {p.state === "empty" && (
        <EmptyCard session={p.session} root={p.root} canResume={p.canResume}
          onShell={p.onShell} onAgent={p.onAgent} onResume={p.onResume} onGo={p.onGo} />
      )}
      {p.state === "notmux" && (
        <NoTmuxNote onInstall={() => openSettings("connections")}
          onDismiss={() => { write(NOTE_KEY, "off"); p.onNoteDismissed(); }} />
      )}
      {closer.ask && <CloseConfirm ask={closer.ask} onStop={closer.confirm} onKeep={closer.keep} />}
      {closer.toast && <ReopenToast toast={closer.toast} onReopen={closer.reopen} onDismiss={closer.dismissToast} />}
    </>
  );
}
