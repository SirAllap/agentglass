import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { fmtAgo } from "../lib/format.ts";
import { listChats } from "../lib/chatStore.ts";
import { usePoll } from "../lib/usePoll.ts";
import type { ChatPane } from "../../../shared/types.ts";
import { Button } from "./workspace/Chrome.tsx";
import { SettingRow } from "./SettingRow.tsx";
import { EmptyState, SettingsCard, StatusBadge } from "./SettingsKit.tsx";

/**
 * What is actually running, and what belongs to nothing.
 *
 * Panes outlive the app. Quit agentglass, or let it crash, and every warm
 * `claude` is still there — several hundred megabytes each, growing with use.
 * The sweeper deliberately leaves any pane it has no record of alone, because
 * killing an agent mid-work to save memory it might be using is a much worse
 * failure than holding the memory, so after a restart they get a fresh grace
 * period each time.
 *
 * That is the right behaviour and it left no way to see the consequence. The
 * only way to find out what was out there was `tmux -L agentglass ls` in a
 * terminal, and the only way to clean up was `kill-session` by hand — for a
 * feature whose entire cost is memory, in an app that otherwise makes a point
 * of showing you what it is doing on your machine.
 *
 * An orphan is named rather than guessed at: it is a pane no open chat and no
 * running turn points at. That judgement needs both halves — which chats this
 * window has open, which only the client knows, and which turns are in flight,
 * which only the server does — so the open list is sent and the answer comes
 * back labelled.
 */
export function RunningPanes({ open }: { open: boolean }) {
  const [panes, setPanes] = useState<ChatPane[] | null>(null);
  const [evictMs, setEvictMs] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(() => {
    const ids = listChats().map((c) => c.sessionId).filter(Boolean);
    api.chatPanes(ids)
      .then((r) => { setPanes(r.panes); setEvictMs(r.idleEvictMs); })
      .catch(() => setPanes([]));
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);
  // Slow: this is a list of long-lived processes, not a live meter, and the
  // listing shells out to tmux.
  usePoll(open, load, 5000);

  const end = async (p: ChatPane) => {
    setBusy(p.name);
    // The same route the close button uses. Ending a pane is ending a pane —
    // there is no second kind, and a route that killed panes and nothing else
    // would be one more thing able to stop an agent.
    await api.chatPaneClose(p.name).catch(() => null);
    setBusy(null);
    setConfirming(null);
    load();
  };

  const card = (children: React.ReactNode, status?: React.ReactNode, desc?: React.ReactNode) => (
    <SettingsCard title="Warm CLIs running now" status={status} desc={desc}>{children}</SettingsCard>
  );

  if (!panes) return card(<EmptyState>Looking…</EmptyState>);

  if (!panes.length) {
    return card(<EmptyState>Nothing is running. A chat on the pane engine starts one on its first turn.</EmptyState>);
  }

  const orphans = panes.filter((p) => p.orphan).length;

  return card(
    panes.map((p) => (
      <SettingRow key={p.name}
        label={<span className="inline-flex items-baseline gap-2 flex-wrap">
          <span className="t-mono">{p.name.slice(0, 8)}</span>
          {p.pinned && <span className="chip" style={{ color: "var(--primary-ink)" }}>pinned</span>}
          {p.orphan && <span className="chip" style={{ color: "var(--warning-ink)" }}>no chat</span>}
        </span>}
        hint={p.running
          ? "Working right now"
          : p.orphan
            ? "Left over from a previous run, or started by hand. Nothing in this window is using it."
            : p.lastUsedAt
              ? `Last turn ${fmtAgo(p.lastUsedAt)}`
              : "No turn run from this window yet"}
        status={<StatusBadge tone={p.running ? "ok" : p.orphan ? "warn" : "off"}>{p.running ? "Working" : p.orphan ? "Left over" : "Idle"}</StatusBadge>}
        /* Never for one mid-turn. Ending a pane while the agent is working is
           the one action here that loses something, and a confirm under the
           thumb that just clicked is the weakest guard there is. */
        actions={p.running ? undefined : (
          confirming === p.name ? (
            <>
              <Button tone="danger" onClick={() => void end(p)} disabled={busy === p.name}>End it</Button>
              <Button onClick={() => setConfirming(null)}>Keep</Button>
            </>
          ) : (
            <Button onClick={() => setConfirming(p.name)}
              title="Kill this pane and free its memory. The chat it belongs to, if any, starts a fresh CLI on its next turn.">
              End
            </Button>
          )
        )} />
    )),
    <StatusBadge tone={orphans > 0 ? "warn" : "off"}>
      {panes.length === 1 ? "One warm CLI" : `${panes.length} warm CLIs`}
      {orphans > 0 && ` · ${orphans} belonging to nothing`}
    </StatusBadge>,
    <>
      {/* Said rather than implied: somebody who has switched eviction off is
          looking at a list that will never shrink on its own, and that is the
          single most useful thing this panel can tell them. */}
      {evictMs > 0
        ? `Reclaimed after ${Math.round(evictMs / 60_000)} idle minutes`
        : "Idle eviction is off — nothing here is reclaimed on its own"}
      . Ending one frees its memory and loses nothing: the chat it belongs to resumes in a fresh CLI on
      its next turn, one slower turn later.
    </>,
  );
}
