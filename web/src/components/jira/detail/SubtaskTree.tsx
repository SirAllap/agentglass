/*
 * The card's sub-tasks as a tree under it, with the context menu of the mockup's P09: Promote, Change parent, Move up and down
 * (Alt+Up, Alt+Down on a focused row) and Mark done (Space on a focused row, not already done). Move is Jira's rank write and
 * Mark done the card's own done step, both the writes the board already makes and both behind the writes switch. Promote and
 * Change parent have no write in agentglass, so their rows are drawn off with the reason; nothing new is sent to Jira from here.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import { api } from "../../../lib/api.ts";
import { rankAsk, subtaskDetailMenu, swapped } from "../../../lib/cardDetailMenu.ts";
import { openCard } from "../../../lib/openCard.ts";
import { TRACKERS } from "../../../lib/trackerApi.ts";
import { JiraMenuView } from "../list/menus/JiraMenu.tsx";
import { SubtasksBlock, type JoinAct } from "../JiraJoins.tsx";
import { SubtasksSection } from "../JiraSections.tsx";
import type { AddAsk } from "../../../lib/stateRule.ts";
import { JD_TREE_STEP } from "./metrics.ts";

const keyOf = (t: ProviderTask): string => t.customId ?? t.id;

export function SubtaskTree({ rows, parent, writes, act, onOpenCard, onRows, folded, ask }: {
  folded?: boolean; ask?: AddAsk;
  rows: ProviderTask[]; parent: ProviderTask; writes: boolean; act: JoinAct;
  /** A left click on a row: open it in place rather than through the cross-view jump, so the list under this
   *  card never turns into Looked up for a sub-task that is already in hand. Absent, a row falls back to that jump. */
  onOpenCard?: (t: ProviderTask) => void;
  /** The sub-tasks in a new order, once Jira has taken the move. */
  onRows: (rows: ProviderTask[]) => void;
}) {
  const [menu, setMenu] = useState<{ t: ProviderTask; x: number; y: number } | null>(null);
  const [note, setNote] = useState("");
  const refocus = useRef<number | null>(null);
  useEffect(() => { setNote(""); setMenu(null); }, [parent.id]);
  useEffect(() => {
    if (refocus.current === null) return;
    document.querySelectorAll<HTMLElement>(".agx-jd-tree .agx-dk-mini")[refocus.current]?.querySelector<HTMLElement>("button")?.focus();
    refocus.current = null;
  }, [rows]);

  const move = async (i: number, dir: -1 | 1) => {
    const ask = rankAsk(rows.map(keyOf), i, dir);
    if (!writes || !ask) return;
    const r = await api.jiraRank(keyOf(rows[i]!), ask).catch(() => null);
    if (!r || !r.ok) { setNote(`!${r?.error || "Jira refused that move"}`); return; }
    setNote("");
    refocus.current = i + dir;
    onRows(swapped(rows, i, dir));
  };

  const markDone = async (t: ProviderTask) => {
    const o = await TRACKERS.jira.statusOptions(t).catch(() => null);
    const step = o?.ok ? o.data?.find((x) => x.toKind === "done" && !x.needs?.length) : undefined;
    if (!step) { setNote(`!${o?.ok ? `No plain done step from ${t.status}` : o?.error || "Could not read the steps"}`); return; }
    const r = await TRACKERS.jira.setStatus(t, step).catch(() => null);
    if (!r?.ok || !r.task) { setNote(`!${r?.error || "Jira refused that move"}`); return; }
    setNote("");
    act.onRowTask(r.task);
  };

  const onPick = (id: string) => {
    const t = menu?.t;
    if (!t) return;
    const i = rows.findIndex((x) => x.id === t.id);
    if (id === "open") openCard(keyOf(t), keyOf(t), "jira");
    else if (id === "copyKey") void navigator.clipboard?.writeText(keyOf(t)).catch(() => undefined);
    else if (id === "up") void move(i, -1);
    else if (id === "down") void move(i, 1);
    else if (id === "done") void markDone(t);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = [...e.currentTarget.querySelectorAll(".agx-dk-mini")];
    const i = els.findIndex((el) => el.contains(e.target as Node));
    if (i < 0) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      void move(i, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    // Space marks the focused sub-task done, the same step its own menu row runs.
    if (e.key === " " && !e.altKey && !e.ctrlKey && !e.metaKey && writes && rows[i]!.statusKind !== "done") {
      e.preventDefault();
      void markDone(rows[i]!);
    }
  };

  const onMenu = (e: MouseEvent, t: ProviderTask) => setMenu({ t, x: e.clientX, y: e.clientY });
  const at = menu ? rows.findIndex((x) => x.id === menu.t.id) : -1;

  return (
    <div className="agx-jd-tree" onKeyDown={onKeyDown} style={{ "--jd-tree-step": `${JD_TREE_STEP}px` } as React.CSSProperties}>
      {writes ? <SubtasksBlock rows={rows} parent={parent} writable act={act} folded={folded} ask={ask} onMenu={onMenu} onOpenCard={onOpenCard} /> : <SubtasksSection rows={rows} onMenu={onMenu} onOpenCard={onOpenCard} />}
      {note && <div className="text-[10.5px]" role="status" style={{ color: note.startsWith("!") ? "var(--warning-ink)" : "var(--success-ink)" }}>{note.replace(/^!/, "")}</div>}
      {menu && <JiraMenuView menu={subtaskDetailMenu(menu.t, { writable: writes, index: at, count: rows.length, done: menu.t.statusKind === "done" })} x={menu.x} y={menu.y} onPick={onPick} onClose={() => setMenu(null)} />}
    </div>
  );
}
