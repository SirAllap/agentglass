import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { fmtAgo } from "../lib/format.ts";
import { listChats } from "../lib/chatStore.ts";
import { usePoll } from "../lib/usePoll.ts";
import type { ChatPane } from "../../../shared/types.ts";

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

  if (!panes) return <div className="text-[11px] t-dim2">Looking…</div>;

  if (!panes.length) {
    return (
      <div className="text-[11px] t-dim2">
        Nothing is running. A chat on the pane engine starts one on its first turn.
      </div>
    );
  }

  const orphans = panes.filter((p) => p.orphan).length;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px]" style={{ color: "var(--text2)" }}>
          {panes.length === 1 ? "One warm CLI" : `${panes.length} warm CLIs`}
          {orphans > 0 && <span style={{ color: "var(--warning)" }}> · {orphans} belonging to nothing</span>}
        </span>
        <span className="text-[10px] t-dim2 ml-auto">
          {/* Said rather than implied: somebody who has switched eviction off
              is looking at a list that will never shrink on its own, and that
              is the single most useful thing this panel can tell them. */}
          {evictMs > 0
            ? `Reclaimed after ${Math.round(evictMs / 60_000)} idle minutes`
            : "Idle eviction is off — nothing here is reclaimed on its own"}
        </span>
      </div>

      {panes.map((p) => (
        <div key={p.name} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg" style={{
          background: p.orphan ? "color-mix(in srgb, var(--warning) 8%, transparent)" : "color-mix(in srgb, var(--bg2) 60%, transparent)",
          border: `1px solid color-mix(in srgb, ${p.orphan ? "var(--warning)" : "var(--border)"} ${p.orphan ? 32 : 40}%, transparent)`,
        }}>
          <span className="shrink-0 rounded-full" aria-hidden style={{
            width: 7, height: 7,
            background: p.running ? "var(--success)" : "transparent",
            border: p.running ? "none" : "1px solid var(--text4)",
          }} />
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] t-mono truncate" style={{ color: "var(--text)" }}>
              {p.name.slice(0, 8)}
              {p.pinned && <span className="chip ml-1.5" style={{ color: "var(--primary-hover)" }}>pinned</span>}
              {p.orphan && <span className="chip ml-1.5" style={{ color: "var(--warning)" }}>no chat</span>}
            </div>
            <div className="text-[10px] t-dim2">
              {p.running
                ? "Working right now"
                : p.orphan
                  ? "Left over from a previous run, or started by hand. Nothing in this window is using it."
                  : p.lastUsedAt
                    ? `Last turn ${fmtAgo(p.lastUsedAt)}`
                    : "No turn run from this window yet"}
            </div>
          </div>
          {/* Never for one mid-turn. Ending a pane while the agent is working
              is the one action here that loses something, and a confirm under
              the thumb that just clicked is the weakest guard there is. */}
          {!p.running && (
            confirming === p.name ? (
              <div className="flex items-center gap-1.5 shrink-0">
                <button onClick={() => void end(p)} disabled={busy === p.name}
                  className="text-[10.5px] px-2 py-1 rounded-md"
                  style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 40%, transparent)" }}>
                  End it
                </button>
                <button onClick={() => setConfirming(null)}
                  className="text-[10.5px] px-2 py-1 rounded-md hover:opacity-80"
                  style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                  Keep
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirming(p.name)}
                title="Kill this pane and free its memory. The chat it belongs to, if any, starts a fresh CLI on its next turn."
                className="shrink-0 text-[10.5px] px-2 py-1 rounded-md hover:opacity-80"
                style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                End
              </button>
            )
          )}
        </div>
      ))}

      <div className="text-[10px] t-dim2">
        Ending one frees its memory and loses nothing: the chat it belongs to resumes in a fresh CLI on
        its next turn, one slower turn later.
      </div>
    </div>
  );
}
