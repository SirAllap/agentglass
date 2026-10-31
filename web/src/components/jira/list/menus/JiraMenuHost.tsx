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
import { askDock } from "./dockIntent.ts";
import { laneFolded, laneSortOf, setLaneFolded, setLaneSort, useLaneState } from "../../../../lib/jiraLaneState.ts";
import type { LaneSort } from "../laneModel.ts";
import { cardMenu, jqlUrl, laneMenu, sortMenu, subtaskMenu, type JiraMenu, type MoveFacts } from "./menuModel.ts";
import { TRACKERS } from "../../../../lib/trackerApi.ts";
import { hideCard, showCards, togglePin, updatePrefs, usePrefs } from "./viewPrefs.ts";

type Subject =
  | { kind: "card"; t: ProviderTask }
  | { kind: "sub"; t: ProviderTask }
  | { kind: "lane"; lane: JiraLane }
  | { kind: "sort"; lane: JiraLane };

interface Open { subject: Subject; x: number; y: number }

export interface JiraMenuHandlers {
  onRowMenu: (e: MouseEvent, card: ProviderTask) => void;
  onLaneMenu: (e: MouseEvent, lane: JiraLane) => void;
  onSubtaskMenu: (e: MouseEvent, card: ProviderTask) => void;
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
  const handlers: JiraMenuHandlers = {
    onRowMenu: (e, t) => raise(e, { kind: "card", t }),
    onLaneMenu: (e, lane) => raise(e, { kind: "lane", lane }),
    onSubtaskMenu: (e, t) => raise(e, { kind: "sub", t }),
  };

  useEffect(() => {
    if (!open || !target) return;
    target.setAttribute("data-ctx", "1");
    return () => target.removeAttribute("data-ctx");
  }, [open === null, target]); // eslint-disable-line react-hooks/exhaustive-deps

  return { handlers, host: open ? <MenuHost deps={deps} open={open} setOpen={setOpen} /> : null };
}

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
  const about = subject.kind === "card" || subject.kind === "sub" ? subject.t : null;
  const [steps, setSteps] = useState<{ id: string; m: MoveFacts } | null>(null);
  useEffect(() => {
    if (!about || !writable) return;
    let gone = false;
    void TRACKERS.jira.statusOptions(about)
      .then((r) => ({ to: (r.data ?? []).map((x) => ({ status: x.toStatus, asks: !!x.needs?.length })), ok: r.ok, error: r.error }))
      .catch(() => ({ to: [], ok: false, error: "Could not reach the server" }))
      .then((r) => { if (!gone) setSteps({ id: about.id, m: r.ok ? { to: r.to } : { error: r.error ?? "" } }); });
    return () => { gone = true; };
  }, [about?.id, about?.status, writable]); // eslint-disable-line react-hooks/exhaustive-deps
  const moves: MoveFacts = steps && steps.id === about?.id ? steps.m : "reading";
  const close = () => setOpen(null);
  const change = (f: Parameters<typeof updatePrefs>[1]) => { if (viewId) updatePrefs(viewId, f); };
  const view = viewId ?? "";
  const isFolded = (l: JiraLane) => laneFolded(view, laneKey(l), !!l.folded);
  const sortOf = (l: JiraLane) => laneSortOf(view, laneKey(l));

  let menu: JiraMenu;
  if (subject.kind === "card") {
    const pick = pickCardPr(cardPrsOf(subject.t.id, keyOf(subject.t), "", "", "jira")?.prs);
    const pr = pick.kind === "one" ? pick.pr : pick.kind === "many" ? pick.primary : null;
    menu = cardMenu(subject.t, { pr: pr ? pr.number : null, pinned: prefs.pinned.includes(subject.t.id), writable, moves });
  } else if (subject.kind === "sub") {
    const pk = subject.t.parent?.key ?? (selected && selected.id !== subject.t.id ? keyOf(selected) : null);
    menu = subtaskMenu(subject.t, pk ? { key: pk, openable: !!parentOf(model, selected, pk) } : null, { writable, moves });
  } else if (subject.kind === "lane") {
    const { lane } = subject;
    const hidden = (findLane(model.lanes, laneKey(lane))?.cards ?? []).filter((t) => prefs.hidden.includes(t.id)).length;
    menu = laneMenu({ status: lane.status, cards: lane.cards, folded: isFolded(lane), sort: sortOf(lane), hidden });
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

  const onPick = (id: string): void | "stay" => {
    if (subject.kind === "sort") {
      setLaneSort(view, laneKey(subject.lane), id.slice("sort:".length) as LaneSort);
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
      case "openJira": openExternal(t.url); return;
      case "move": case "assign": case "comment": onOpen(t); askDock(t.id, id); return;
      case "copyKey": copy(keyOf(t), keyOf(t)); return;
      case "copyLink": copy(t.url, `the link to ${keyOf(t)}`); return;
      case "copyBranch": copy(branchName(keyOf(t), t.title), "the branch name"); return;
      case "pr": openPull(t); return;
      case "pin": change((p) => togglePin(p, t.id)); return;
      case "hide": change((p) => hideCard(p, t.id)); return;
      case "reread":
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

  return <JiraMenuView key={menu.head} menu={menu} x={open.x} y={open.y} onPick={onPick} onClose={close} />;
}

/** The card a sub-task hangs under, if this list can open it: on the page, or the one open in the dock. */
function parentOf(model: JiraListModel, selected: ProviderTask | null, key: string): ProviderTask | null {
  if (selected && keyOf(selected) === key) return selected;
  return model.cards.find((t) => keyOf(t) === key) ?? null;
}
