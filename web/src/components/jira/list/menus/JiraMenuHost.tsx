/*
 * The list's right-click menus: the handlers a row, a lane head and a sub-task row call (`onRowMenu`, `onLaneMenu`,
 * `onSubtaskMenu`), and the one menu that is open. menuModel.ts decides what a menu offers; this file says what a row
 * DOES, using what the app already has: the dock (the card pane) for Move / Assign / Comment through dockIntent, the
 * card finder for "read again", the pull-request opener, the clipboard and the browser.
 *
 * The open menu keeps its SUBJECT, not its rows, and builds the rows on every render: a pull request that lands
 * while the menu is open turns "No pull request linked yet" into a row that works.
 *
 * The target row keeps `data-ctx` while its menu is open, so the eye never loses what the menu is about.
 */
import { forgetKey, jiraDetailKey } from "../../../../lib/remoteStore.ts";
import { useCallback, useEffect, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import type { ProviderTask } from "../../../../../../shared/providers.ts";
import type { BoardSource } from "../../../../lib/boardSource.ts";
import type { FooterNote } from "../../../../lib/tasksFooterNote.ts";
import { branchName } from "../../../../lib/cardBranch.ts";
import { cardPrsOf, cardPrVersion, onCardPrs } from "../../../../lib/cardPrStore.ts";
import { pickCardPr } from "../../../../lib/cardPrPick.ts";
import { openExternal } from "../../../../lib/externalUrl.ts";
import { openPr, openPrs, prRefFromUrl } from "../../../../lib/openPrs.ts";
import type { JiraLane, JiraListModel } from "../model.ts";
import { JiraMenuView } from "./JiraMenu.tsx";
import { JiraCardMenu } from "./JiraCardMenu.tsx";
import { JiraAssignPop } from "./JiraAssignPop.tsx";
import { assignPop, cardActions } from "./cardActions.ts";
import { useCardBoard, type CardBoardReads } from "./cardBoard.ts";
import { peopleOf } from "../PeopleFaces.tsx";
import { openFlightPlan } from "../../../../lib/flightPlanNav.ts";
import { askDock } from "./dockIntent.ts";
import { finishedFor, fleetNow, workerFor } from "../../../../lib/jiraCardWork.ts";
import { openLive } from "../../detail/cardWorkActions.ts";
import { laneFolded, laneSortOf, setLaneFolded, setLaneSort, useLaneState } from "../../../../lib/jiraLaneState.ts";
import type { LaneSort } from "../laneModel.ts";
import { currentSprintOf, sprintMoveAsk } from "../viewsModel.ts";
import { WRITES_OFF_WHY, jqlUrl, laneMenu, sortMenu, statusMenu, subtaskMenu, type JiraMenu, type MoveFacts } from "./menuModel.ts";
import { TRACKERS } from "../../../../lib/trackerApi.ts";
import { api } from "../../../../lib/api.ts";
import type { StatusOption } from "../../../../lib/trackerStatus.ts";
import { hideCard, showCards, togglePin, updatePrefs, usePrefs } from "./viewPrefs.ts";

type Subject =
  | { kind: "card"; t: ProviderTask }
  | { kind: "sub"; t: ProviderTask }
  | { kind: "lane"; lane: JiraLane }
  | { kind: "sort"; lane: JiraLane }
  | { kind: "status"; t: ProviderTask }
  | { kind: "assign"; t: ProviderTask };

interface Open { subject: Subject; x: number; y: number }

export interface JiraMenuHandlers {
  onRowMenu: (e: MouseEvent, card: ProviderTask) => void;
  onLaneMenu: (e: MouseEvent, lane: JiraLane) => void;
  onSubtaskMenu: (e: MouseEvent, card: ProviderTask) => void;
  /** `s` on a focused board row: the Status menu, raised on that row rather than on a click. */
  onStatusMenu: (el: HTMLElement, card: ProviderTask) => void;
  /** A click on a card's face: the Assign popover, raised on the face. */
  onAssignMenu: (el: HTMLElement, card: ProviderTask) => void;
}

export interface JiraMenuDeps {
  model: JiraListModel;
  source: BoardSource;
  viewId: string | null;
  /** Whether this app may change Jira at all: Move / Assign / Comment are off with that reason when not. */
  writable: boolean;
  /** The footer's note mode: where a copy says it happened. */
  onNote?: (n: FooterNote) => void;
  /** The card open in the dock: a sub-task menu raised from the dock hangs under it. */
  selected: ProviderTask | null;
  /** Open a card in the dock (any card: a sub-task or a parent may not be on the page). */
  onOpen: (t: ProviderTask) => void;
}

const keyOf = (t: ProviderTask): string => t.customId ?? t.id;
const laneKey = (l: JiraLane): string => l.key ?? l.status;
/** A lane by key, in the top level or one level down. */
function findLane(lanes: readonly JiraLane[], key: string): JiraLane | undefined {
  for (const l of lanes) {
    if (laneKey(l) === key) return l;
    const inner = l.sub?.find((s) => laneKey(s) === key);
    if (inner) return inner;
  }
  return undefined;
}
/** The line the footer says after a copy ("Copied ORB-52"), in the footer's own note mode. */
export function copiedNote(what: string, ok = true): FooterNote {
  return ok ? { ok: true, text: `Copied ${what}` } : { ok: false, text: `Could not copy ${what}` };
}

/** The handlers and the node to render once, anywhere under the list. */
export function useJiraMenus(deps: JiraMenuDeps): { handlers: JiraMenuHandlers; host: ReactNode } {
  const [open, setOpen] = useState<Open | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);

  const raise = useCallback((e: MouseEvent, subject: Subject) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    setTarget(el);
    /* The context-menu key has no pointer: (0, 0) means open it on the row itself. */
    const r = el.getBoundingClientRect();
    const keyboard = e.clientX === 0 && e.clientY === 0;
    setOpen({ subject, x: keyboard ? r.left + 24 : e.clientX, y: keyboard ? r.top + r.height / 2 : e.clientY });
  }, []);
  const raiseAt = useCallback((el: HTMLElement, subject: Subject) => {
    setTarget(el);
    const r = el.getBoundingClientRect();
    setOpen({ subject, x: r.left + 24, y: r.top + r.height / 2 });
  }, []);
  const handlers: JiraMenuHandlers = {
    onRowMenu: (e, t) => raise(e, { kind: "card", t }),
    onLaneMenu: (e, lane) => raise(e, { kind: "lane", lane }),
    onSubtaskMenu: (e, t) => raise(e, { kind: "sub", t }),
    onStatusMenu: (el, t) => raiseAt(el, { kind: "status", t }),
    onAssignMenu: (el, t) => raiseAt(el, { kind: "assign", t }),
  };

  useEffect(() => {
    if (!open || !target) return;
    target.setAttribute("data-ctx", "1");
    return () => target.removeAttribute("data-ctx");
  }, [open === null, target]); // eslint-disable-line react-hooks/exhaustive-deps

  return { handlers, host: open ? <MenuHost deps={deps} open={open} setOpen={setOpen} /> : null };
}

const CARD_BOARD_READS: CardBoardReads = { projectBoards: (k) => api.jiraProjectBoards(k), boardContext: (v) => api.jiraBoardContext(v) };

function MenuHost({ deps, open, setOpen }: { deps: JiraMenuDeps; open: Open; setOpen: (o: Open | null) => void }) {
  const { model, source, viewId, selected, onOpen, writable, onNote } = deps;
  const copy = (text: string, what: string) => {
    const w = navigator.clipboard?.writeText(text);
    if (!w) { onNote?.(copiedNote(what, false)); return; }
    w.then(() => onNote?.(copiedNote(what)), () => onNote?.(copiedNote(what, false)));
  };
  const prefs = usePrefs(viewId);
  useLaneState();
  useSyncExternalStore(onCardPrs, cardPrVersion, cardPrVersion);
  const { subject } = open;
  /* The steps from where the card stands, read once when the menu is raised on a card (a request only for a person's click). */
  const about = subject.kind === "card" || subject.kind === "sub" || subject.kind === "status" ? subject.t : null;
  const [steps, setSteps] = useState<{ id: string; m: MoveFacts } | null>(null);
  useEffect(() => {
    if (!about || !writable) return;
    let gone = false;
    void TRACKERS.jira.statusOptions(about)
      .then((r) => ({ to: (r.data ?? []).map((x) => ({ status: x.toStatus, asks: !!x.needs?.length, key: x.key })), ok: r.ok, error: r.error }))
      .catch(() => ({ to: [], ok: false, error: "Could not reach the server" }))
      .then((r) => { if (!gone) setSteps({ id: about.id, m: r.ok ? { to: r.to } : { error: r.error ?? "" } }); });
    return () => { gone = true; };
  }, [about?.id, about?.status, writable]); // eslint-disable-line react-hooks/exhaustive-deps
  const moves: MoveFacts = steps && steps.id === about?.id ? steps.m : "reading";
  /* The card's board, for the Sprint row: the board view's own context, or (a list, a saved filter, a JQL view) the board
     its project has with sprints, read when the menu is raised on a card. */
  const boardCtx = useCardBoard(subject.kind === "card" ? subject.t : null, model.context, source.moveToSprint ? CARD_BOARD_READS : null);
  const sprintNow = model.sprint ?? boardCtx?.sprint;
  const close = () => setOpen(null);
  const change = (f: Parameters<typeof updatePrefs>[1]) => { if (viewId) updatePrefs(viewId, f); };
  const view = viewId ?? "";
  const isFolded = (l: JiraLane) => laneFolded(view, laneKey(l), !!l.folded);
  const sortOf = (l: JiraLane) => laneSortOf(view, laneKey(l));

  const peopleFor = (t: ProviderTask) => {
    const faces = peopleOf(model.cards).filter((p) => !!p.key);
    const on = new Set((t.people ?? []).map((x) => x.key));
    return [...faces.filter((p) => p.me), ...faces.filter((p) => !p.me)].map((p) => ({ key: p.key!, name: p.name, ...(p.me ? { me: true } : {}), ...(on.has(p.key) ? { on: true } : {}) }));
  };
  /* The assign and card menus are built here but returned after `pickCard` and `onPick` exist: a `const` below an early return is never
     run, so the menu's own pick handed an uninitialised `pickCard` and every card-menu row did nothing (Sprint included). */
  let early: ReactNode = null;
  let menu: JiraMenu | undefined;
  if (subject.kind === "assign") {
    early = <JiraAssignPop rows={assignPop({ writable, people: peopleFor(subject.t) }, subject.t.assignees.length > 0)} x={open.x} y={open.y} onPick={(id) => pickCard(subject.t, id)} onClose={close} />;
  } else if (subject.kind === "card") {
    /* The card's own menu is a different shape (a filter box and submenus): JiraCardMenu draws it, not JiraMenuView. */
    const t = subject.t;
    const pick = pickCardPr(cardPrsOf(t.id, keyOf(t), "", "", "jira")?.prs);
    const pr = pick.kind === "one" ? pick.pr : pick.kind === "many" ? pick.primary : null;
    const people = peopleFor(t);
    const acts = cardActions(t, { pr: pr ? pr.number : null, pinned: prefs.pinned.includes(t.id), writable, moves, agent: !!workerFor(keyOf(t), fleetNow()), people, ...(source.moveToSprint ? { sprint: currentSprintOf(sprintNow, model.cards, t), inSprint: !!t.sprintActive, futures: boardCtx?.futures ?? (boardCtx?.next ? [boardCtx.next] : []), sprintId: t.sprintId ?? null, inBacklog: !t.sprint } : {}), ...(model.context ? { epics: model.epics.filter((e) => !e.done).map((e) => ({ key: e.key, name: e.name })) } : {}) });
    early = <JiraCardMenu key={acts.head} menu={acts} x={open.x} y={open.y} onPick={(id) => pickCard(t, id)} onClose={close} />;
  } else if (subject.kind === "sub") {
    const pk = subject.t.parent?.key ?? (selected && selected.id !== subject.t.id ? keyOf(selected) : null);
    menu = subtaskMenu(subject.t, pk ? { key: pk, openable: !!parentOf(model, selected, pk) } : null, { writable, moves });
  } else if (subject.kind === "lane") {
    const { lane } = subject;
    const hidden = (findLane(model.lanes, laneKey(lane))?.cards ?? []).filter((t) => prefs.hidden.includes(t.id)).length;
    menu = laneMenu({ status: lane.status, cards: lane.cards, folded: isFolded(lane), sort: sortOf(lane), hidden });
  } else if (subject.kind === "status") {
    menu = statusMenu(subject.t, moves, writable);
  } else {
    menu = sortMenu(subject.lane.status, sortOf(subject.lane));
  }

  const openPull = (t: ProviderTask) => {
    const pick = pickCardPr(cardPrsOf(t.id, keyOf(t), "", "", "jira")?.prs);
    const p = pick.kind === "one" ? pick.pr : pick.kind === "many" ? pick.primary : null;
    if (!p) return;
    const ref = prRefFromUrl(p.url);
    if (ref) openPr(ref.repo, p.number);
    else openPrs(String(p.number), p.state === "OPEN" ? "open" : "all");
  };

  /** Say what a write did, in the footer's note: "…" first, then the outcome. A throw is a note too, never a silent failure. */
  const attempt = (doing: string, run: () => Promise<{ ok: boolean; error?: string; task?: ProviderTask } | null>, done: string | ((r: { task?: ProviderTask }) => string)): void => {
    if (!writable) { onNote?.({ ok: false, text: WRITES_OFF_WHY }); return; }
    onNote?.({ ok: true, text: doing });
    void run().then(
      (r) => {
        if (!r) { onNote?.({ ok: false, text: "Could not reach the server" }); return; }
        onNote?.({ ok: r.ok, text: r.ok ? (typeof done === "string" ? done : done(r)) : r.error || "Jira refused that" });
        if (r.ok && r.task) model.fold(r.task); else if (r.ok) model.refresh();
      },
      () => onNote?.({ ok: false, text: "Could not reach the server" }),
    );
  };

  /** The card menu's rows: the ids are cardActions.ts's. A throw inside a row's handler shows as a note instead of nothing. */
  const pickCard = (t: ProviderTask, id: string): void => {
    try { pickCardNow(t, id); } catch (e) { onNote?.({ ok: false, text: `That did not work: ${e instanceof Error ? e.message : "unknown error"}` }); }
  };
  /** The rows' work. Move, Assign and Sprint write through the same calls the dock and the Status menu use. */
  const pickCardNow = (t: ProviderTask, id: string): void => {
    if (id.startsWith("move:")) {
      const k = id.slice(5);
      const m = moves !== "reading" && "to" in moves ? moves.to.find((x, i) => (x.key ?? String(i)) === k) : undefined;
      if (!m) return;
      if (m.asks || !m.key) { onOpen(t); askDock(t.id, "move"); return; }
      const opt: StatusOption = { key: m.key, label: m.status, toStatus: m.status, toKind: "open" };
      onNote?.({ ok: true, text: "moving…" });
      void TRACKERS.jira.setStatus(t, opt).then((r) => {
        onNote?.({ ok: r.ok, text: r.ok ? `now ${opt.toStatus}` : r.error || "Jira refused that" });
        if (r.ok && r.task) model.fold(r.task);
      });
      return;
    }
    if (id.startsWith("sprint:to:")) {
      const sid = id.slice(10);
      const n = (boardCtx?.futures ?? (boardCtx?.next ? [boardCtx.next] : [])).find((x) => x.id === sid);
      if (!n) { onNote?.({ ok: false, text: "That sprint is no longer planned" }); return; }
      attempt("moving…", () => source.moveToSprint?.(n.id, [keyOf(t)]) ?? Promise.resolve(null), `Moved ${keyOf(t)} to ${n.name}`);
      return;
    }
    if (id.startsWith("assign:")) { assignTo(t, id.slice(7) || null); return; }
    if (id.startsWith("epic:")) {
      const epic = id.slice(5) || null;
      attempt(epic ? "setting the epic…" : "taking it out of its epic…", () => api.jiraEdit(keyOf(t), { field: "parent", value: epic }, t.updated ?? 0) as Promise<{ ok: boolean; error?: string; task?: ProviderTask }>, epic ? `${keyOf(t)} is now in ${epic}` : `${keyOf(t)} has no epic`);
      return;
    }
    switch (id) {
      case "edit": onOpen(t); askDock(t.id, "edit"); return;
      case "subtask": onOpen(t); askDock(t.id, "subtask"); return;
      case "clone":
        attempt("cloning…", () => api.jiraClone(keyOf(t)), (r) => `Cloned ${keyOf(t)} as ${(r as { created?: string }).created ?? "a new card"}`);
        return;
      case "sprint:next": onNote?.({ ok: false, text: "No next sprint is planned" }); return;
      case "sprint:backlog":
        attempt("moving…", () => source.moveToBacklog?.([keyOf(t)]) ?? Promise.resolve(null), `Moved ${keyOf(t)} to the backlog`);
        return;
      case "terminal": case "next": case "worker": onOpen(t); askDock(t.id, "next"); return;
      case "copyPrompt": copy(`Work on ${keyOf(t)}: ${t.title}`, "the prompt"); return;
      case "flight": openFlightPlan({ compose: { taskId: t.id, request: `${keyOf(t)} ${t.title}` } }); return;
      case "sprint:current": onPick("sprint"); return;
      default: onPick(id);
    }
  };
  const assignTo = (t: ProviderTask, who: string | null) => {
    onNote?.({ ok: true, text: "assigning…" });
    void TRACKERS.jira.setPeople?.(t, { set: who }).then((r) => {
      onNote?.({ ok: r.ok, text: r.ok ? (who ? "assigned" : "unassigned") : r.error || "Jira refused that" });
      if (r.ok && r.task) model.fold(r.task);
    });
  };

  const onPick = (id: string): void | "stay" => {
    if (subject.kind === "sort") {
      setLaneSort(view, laneKey(subject.lane), id.slice("sort:".length) as LaneSort);
      return;
    }
    if (subject.kind === "status") {
      const picked = moves !== "reading" && "to" in moves ? moves.to.find((m) => (m.key ?? "") === id) : undefined;
      if (!picked?.key) return;
      const opt: StatusOption = { key: picked.key, label: picked.status, toStatus: picked.status, toKind: "open" };
      onNote?.({ ok: true, text: "moving…" });
      void TRACKERS.jira.setStatus(subject.t, opt).then((r) => {
        onNote?.({ ok: r.ok, text: r.ok ? `now ${opt.toStatus}` : r.error || "Jira refused that" });
        if (r.ok && r.task) model.fold(r.task);
      });
      return;
    }
    if (subject.kind === "lane") {
      const { lane } = subject;
      switch (id) {
        case "collapse": setLaneFolded(view, [laneKey(lane)], !isFolded(lane)); return;
        case "collapseAll": setLaneFolded(view, model.lanes.map(laneKey), true); return;
        case "sort": setOpen({ ...open, subject: { kind: "sort", lane } }); return "stay";
        case "copyKeys": copy(lane.cards.map(keyOf).join(", "), `the ${lane.cards.length} ${lane.cards.length === 1 ? "key" : "keys"}`); return;
        case "openJql": openExternal(jqlUrl(lane.cards)); return;
        case "unhide": change((p) => showCards(p, (findLane(model.lanes, laneKey(lane))?.cards ?? []).map((t) => t.id))); return;
      }
      return;
    }
    const t = subject.t;
    switch (id) {
      case "open": onOpen(t); return;
      case "agentWork": onOpen(t); askDock(t.id, "work"); return;
      case "agentTab": { const w = workerFor(keyOf(t), fleetNow()); if (w) openLive(null, w); return; }
      case "openJira": openExternal(t.url); return;
      case "move": case "assign": case "comment": case "next": onOpen(t); askDock(t.id, id); return;
      case "sprint": {
        /* Through attempt() like Next and Backlog: on its own this row showed no "moving…", skipped the writes-off
           check and never read the board back, so the tick stayed on Backlog after Jira had moved the card. */
        const ask = sprintMoveAsk(currentSprintOf(sprintNow, model.cards, t), [keyOf(t)]);
        if (!ask.ok) { onNote?.({ ok: false, text: ask.error }); return; }
        attempt("moving…", () => source.moveToSprint?.(ask.id, ask.keys) ?? Promise.resolve(null), ask.said);
        return;
      }
      case "copyKey": copy(keyOf(t), keyOf(t)); return;
      case "copyLink": copy(t.url, `the link to ${keyOf(t)}`); return;
      case "copyBranch": copy(branchName(keyOf(t), t.title), "the branch name"); return;
      case "pr": openPull(t); return;
      case "pin": change((p) => togglePin(p, t.id)); return;
      case "hide": change((p) => hideCard(p, t.id)); return;
      case "reread":
        /* The list row and the card's own detail are two reads: dropping the detail's cache means the pane reads Jira again the next time it opens this card, instead of painting what it kept. */
        forgetKey(jiraDetailKey(keyOf(t)));
        void source.find(keyOf(t)).then((r) => { if (r.ok && r.task) model.fold(r.task); }).catch(() => {});
        return;
      case "parent": {
        const pk = t.parent?.key ?? (selected ? keyOf(selected) : "");
        const parent = parentOf(model, selected, pk);
        if (parent) onOpen(parent);
        return;
      }
    }
  };

  if (early || !menu) return early;
  return <JiraMenuView key={menu.head} menu={menu} x={open.x} y={open.y} onPick={onPick} onClose={close} />;
}

/** The card a sub-task hangs under, if this list can open it: on the page, or the one open in the dock. */
function parentOf(model: JiraListModel, selected: ProviderTask | null, key: string): ProviderTask | null {
  if (selected && keyOf(selected) === key) return selected;
  return model.cards.find((t) => keyOf(t) === key) ?? null;
}
