/**
 * "With an agent": every Jira card a live agentglass session is working on, whichever board it sits on.
 *
 * The board's Live worker toggle only narrows the board that is open; this answers "what are my agents on right now"
 * across all of Jira from what the fleet already knows (each session's title and folder), with no request to Jira.
 * A key counts only when its prefix is a space in the sidebar: a folder called `night-types-8` names no card.
 *
 * Below them, dimmed, the cards whose session ended in the last two hours: work that is waiting to be looked at.
 *
 * Right-click a row: open it, its Next step, bring a live agent's tab forward, or copy the key.
 *
 * The row's text is the card's own summary when this page already holds the card (prCardStore: a card opened, or one a
 * pull request names), and the agent's title otherwise. Ceiling: nothing is asked of Jira for it, so a card never read
 * here shows its agent's title until it is opened.
 */
import { useMemo, useState, useSyncExternalStore, type MouseEvent } from "react";
import { PrCardMenu } from "../PrCardMenu.tsx";
import type { CardMenu } from "../../lib/prCardMenu.ts";
import { askDock } from "./list/menus/dockIntent.ts";
import { cardVersion, onCard, peekCard } from "../../lib/prCardStore.ts";
import { openLive } from "./detail/cardWorkActions.ts";
import { usd } from "../../lib/cardLifecycle.ts";
import { agentUrgency, finishedFor, fleetNow, liveKeys, onFleet, workerFor } from "../../lib/jiraCardWork.ts";
import { fmtAgo } from "../../lib/format.ts";
import { ROW_H } from "../../lib/jiraTree.ts";
import { tipAttr } from "../../lib/tip.ts";

type RowMenuId = "open" | "next" | "tab" | "copy" | "none";

/** The row's right-click: open it, do its main step (a terminal, its worker or its PR), or copy the key. */
const rowMenu = (key: string, title: string, live: boolean): CardMenu<RowMenuId> => ({
  head: `${key} · ${title.length > 30 ? `${title.slice(0, 29)}…` : title}`,
  rows: [
    { kind: "item", id: "open", label: "Open the card", icon: "eye", hint: "⏎", strong: true },
    { kind: "item", id: "next", label: "Next step", icon: "spark", sub: "The card's main button: a terminal, its worker or its PR" },
    ...(live ? [{ kind: "item" as const, id: "tab" as const, label: "Bring its tab forward", icon: "term" as const, sub: "The agent's terminal tab, found by its name" }] : []),
    { kind: "item", id: "copy", label: "Copy the key", icon: "copy", sub: key },
  ],
  more: [], close: { kind: "item", id: "none", label: "", icon: "x" }, closeAbsent: true,
});

const TONE: Record<string, string> = { working: "var(--success)", waiting: "var(--warning)", stalled: "var(--error)", errored: "var(--error)" };

export function JiraAgentCards({ spaces, q, onOpen }: { spaces: readonly { key: string }[]; q: string; onOpen: (key: string) => void }) {
  const agents = useSyncExternalStore(onFleet, fleetNow, fleetNow);
  useSyncExternalStore(onCard, cardVersion, cardVersion);
  const named = (key: string, fallback: string): string => peekCard(key, "jira")?.task?.title || fallback;
  const known = useMemo(() => new Set(spaces.map((s) => s.key.toUpperCase())), [spaces]);
  const want = q.trim().toLowerCase();
  const ours = (key: string, title: string) => known.has(key.slice(0, key.lastIndexOf("-"))) && (!want || key.toLowerCase().includes(want) || title.toLowerCase().includes(want));
  /* Read when the fleet changes, which it does on every session event: no clock of its own. */
  const ended = useMemo(() => finishedFor(agents, Date.now()).filter((r) => ours(r.key, r.title)).sort((a, b) => b.at - a.at),
    [agents, known, want]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => {
    return liveKeys(agents)
      .map((k) => ({ key: k, w: workerFor(k, agents) }))
      .filter((r): r is { key: string; w: NonNullable<typeof r.w> } => !!r.w && ours(r.key, r.w.title))
      // Waiting on you first: the rows a person opens this list for. Then stalled or errored, which want a look
      // too, then working. Then by key, so the rest hold still.
      .sort((a, b) => agentUrgency(a.w.status) - agentUrgency(b.w.status) || a.key.localeCompare(b.key, undefined, { numeric: true }));
  }, [agents, known, want]); // eslint-disable-line react-hooks/exhaustive-deps
  const [menu, setMenu] = useState<{ key: string; title: string; x: number; y: number; tab?: { title: string; cwd?: string | null | undefined } } | null>(null);
  const onMenu = (key: string, title: string, tab?: { title: string; cwd?: string | null | undefined }) => (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation(); setMenu({ key, title, x: e.clientX, y: e.clientY, ...(tab ? { tab } : {}) });
  };
  const pick = (key: string, id: RowMenuId, tab?: { title: string; cwd?: string | null | undefined }) => {
    if (id === "tab") { openLive(null, tab); return; }
    if (id === "open") onOpen(key);
    else if (id === "next") { onOpen(key); askDock(key, "next"); }
    else if (id === "copy") void navigator.clipboard?.writeText(key).catch(() => undefined);
  };
  const waiting = rows.filter((r) => r.w.status === "waiting").length;
  const stuck = rows.filter((r) => agentUrgency(r.w.status) === 1).length;
  if (rows.length === 0 && ended.length === 0) return null;
  return (
    <div role="group" aria-label="Cards with an agent" style={{ padding: "8px 8px 0" }}>
      <div role="presentation" className="agx-jsb-cap flex items-center" data-first="">
        <span className="truncate min-w-0 flex-1">With an agent</span>
        {/* The one number on this header worth reading from across the room: agents stopped on a person. */}
        {waiting > 0 && <span className="shrink-0 tabular-nums" style={{ color: "var(--warning-ink)", fontWeight: 600, marginRight: 6 }} data-tip={tipAttr(`${waiting} ${waiting === 1 ? "agent is" : "agents are"} waiting on you`)}>{waiting} need{waiting === 1 ? "s" : ""} you</span>}
        {stuck > 0 && <span className="shrink-0 tabular-nums" style={{ color: "var(--error-ink)", fontWeight: 600, marginRight: 6 }} data-tip={tipAttr(`${stuck} ${stuck === 1 ? "agent has" : "agents have"} stalled or errored`)}>{stuck} stuck</span>}
        <span className="tabular-nums" style={{ color: "var(--text4)" }} data-tip={tipAttr({ name: `${rows.length} working · ${ended.length} finished in the last two hours`, text: `${usd(rows.reduce((n, r) => n + r.w.cost, 0) + ended.reduce((n, r) => n + r.cost, 0))} spent by these agents.` })}>{rows.length}</span>
      </div>
      {rows.map(({ key, w }) => (
        <button key={key} type="button" onClick={() => onOpen(key)} onContextMenu={onMenu(key, w.title, w)} className="agx-rail-row relative flex items-center select-none w-full text-left"
          data-tip={tipAttr({ name: key, mono: true, detail: w.status, text: `${w.doing ? `Now: ${w.doing}. ` : ""}${w.title} · ${w.model ?? "model unknown"} · ${usd(w.cost)} so far. Opens the card.` })}
          style={{ height: ROW_H, gap: 6, padding: "0 8px", borderRadius: 8, fontSize: 12, color: "var(--text2)" }}>
          <span aria-hidden className="shrink-0" style={{ width: 6, height: 6, borderRadius: 99, background: TONE[w.status] ?? "var(--text4)" }} />
          <span className="shrink-0 font-mono" style={{ fontSize: 11, color: "var(--text)" }}>{key}</span>
          <span className="truncate min-w-0 flex-1" style={{ color: "var(--text3)" }}>{named(key, w.title)}</span>
          {/* A session waiting is waiting on a person: said in words, where the cost would be, so it is not just a yellow dot. */}
          {w.status === "waiting"
            /* A click on the words goes straight to the agent's tab, where the answer is typed; the rest of the row opens the
               card. Not a nested button (invalid inside one): the right-click menu's "tab" item is the keyboard way. */
            ? <span className="shrink-0" style={{ fontSize: 11, fontWeight: 600, color: "var(--warning-ink)", cursor: "pointer" }}
                onClick={(e) => { e.stopPropagation(); openLive(null, w); }} data-tip={tipAttr("Bring its tab forward")}>needs you</span>
            : agentUrgency(w.status) === 1
              /* Stalled or errored: the word in red, clickable the same way, since the tab is where the cause is read. */
              ? <span className="shrink-0" style={{ fontSize: 11, fontWeight: 600, color: "var(--error-ink)", cursor: "pointer" }}
                  onClick={(e) => { e.stopPropagation(); openLive(null, w); }} data-tip={tipAttr("Bring its tab forward")}>{w.status}</span>
              : <span className="shrink-0 tabular-nums" style={{ fontSize: 11, color: "var(--text4)" }}>{usd(w.cost)}</span>}
        </button>
      ))}
      {ended.map((r) => (
        <button key={r.key} type="button" onClick={() => { onOpen(r.key); askDock(r.key, "work"); }} onContextMenu={onMenu(r.key, r.title)} className="agx-rail-row relative flex items-center select-none w-full text-left"
          data-tip={tipAttr({ name: r.key, mono: true, detail: "finished", text: `${r.title} ended ${fmtAgo(r.at)} ago · ${usd(r.cost)}. Opens the card on its Work tab, to look at what it did.` })}
          style={{ height: ROW_H, gap: 6, padding: "0 8px", borderRadius: 8, fontSize: 12, color: "var(--text3)", opacity: 0.8 }}>
          <span aria-hidden className="shrink-0" style={{ width: 6, height: 6, borderRadius: 99, boxShadow: "inset 0 0 0 1px var(--text4)" }} />
          <span className="shrink-0 font-mono" style={{ fontSize: 11 }}>{r.key}</span>
          <span className="truncate min-w-0 flex-1" style={{ color: "var(--text4)" }}>{named(r.key, r.title)}</span>
          <span className="shrink-0 tabular-nums" style={{ fontSize: 11, color: "var(--text4)" }}>done {fmtAgo(r.at)}</span>
        </button>
      ))}
      {menu && <PrCardMenu<RowMenuId> menu={rowMenu(menu.key, menu.title, !!menu.tab)} x={menu.x} y={menu.y} onClose={() => setMenu(null)} onPick={(id) => { setMenu(null); pick(menu.key, id, menu.tab); }} />}
    </div>
  );
}
