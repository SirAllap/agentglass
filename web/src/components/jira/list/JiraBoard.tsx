/*
 * The Jira board: one column per status, in the workflow's order, each column ONE fixed width (boardModel.ts). When the
 * columns are wider than the room, the board scrolls sideways and says so: a fade on the edge that has more, a
 * "+N columns" pill that scrolls to the next one, and snap so a scroll lands on a column's edge.
 *
 * Swimlanes split the cards into rows (by epic, assignee, priority or agent state) under ONE row of column heads, so a column keeps
 * its x in every lane. A card is the same anatomy in every state: the type tile, the key (never truncated) and the epic
 * tag (which shrinks first), the priority; the title on two lines; the pull request with its checks; the live agent on
 * it and what it has cost; points, sub-tasks and who is on it. Compact keeps the key, the title and the face. The cards
 * come from the list's own model; the PR, checks and agent come from stores the app already feeds (jiraCardWork.ts).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import type { ListStatus, ProviderTask } from "../../../../../shared/providers.ts";
import { blockersOf } from "../../../lib/boardGroups.ts";
import { epicToneFor } from "../../../lib/jiraBoardContext.ts";
import { familyOf, familyKeyOf, type FamilyRole } from "./familyModel.ts";
import { FamilyRows } from "./FamilyRows.tsx";
import { useFamilyLight } from "./useFamilyLight.ts";
import { agentStateOf, finishedFor, fleetNow, onFleet, workerFor, type CardWorker, type FinishedRun } from "../../../lib/jiraCardWork.ts";
import { ArrowRightIcon, CaretIcon, ClockIcon, CrossIcon, DoneIcon, FlagIcon, MoreIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { Select, type SelectOption } from "../../Select.tsx";
import { statusOptions } from "./bulkPickers.ts";
import { reducedMotion } from "../../../lib/lookPrefs.ts";
import { setConfirmBoardMoves, useConfirmBoardMoves } from "../../../lib/jiraBoardMovePref.ts";
import type { FooterNote } from "../../../lib/tasksFooterNote.ts";
import { TRACKERS } from "../../../lib/trackerApi.ts";
import type { StatusOption } from "../../../lib/trackerStatus.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { openExternal } from "../../../lib/externalUrl.ts";
import { CARD_W, dropDecision, headChips, hiddenRight, isEpicPage, laneOf, nextColumnLeft, opensForDrag, startsCollapsed, staysOpenAfterDrop, openedKey, pruneOpened, shiftToggle, type BoardDensity, type BoardLanes } from "./boardModel.ts";
import { LIFT_TILT_DEG, edgeScroll, pastThreshold, slotIndex, startPending, type CardTop, type PendingMove } from "./dragModel.ts";
import { keyOf } from "./laneModel.ts";
import type { MoveFacts } from "./menus/menuModel.ts";
import { MoveConfirmDialog, MoveResultToast, MoveRunDialog } from "./MoveConfirmDialog.tsx";
import { runDone, type MoveItem, type RunRow, type ScreenRead } from "./moveConfirmModel.ts";
import { lanesOf, nextFlowStatus, quietDays, type JiraLane, type JiraListModel } from "./model.ts";
import { fmtAgo } from "../../../lib/format.ts";
import { dueWords } from "../../../lib/taskGrammar.ts";
import { todayStr } from "./JiraLanes.tsx";
import { EMPTY_SELECTION, toggleSelected, type Selection, seedWithOpen } from "./selectionModel.ts";
import { batchResultLine, dragBatchIds, dropTargets, rangeSelected, type BatchFailure } from "./boardBatchModel.ts";
import { BulkActions } from "./BulkBar.tsx";
import { PeopleFaces } from "./PeopleFaces.tsx";
import { typeMark } from "./JiraRow.tsx";
import { CompactPr, TileBody } from "./JiraTile.tsx";
import { askDock } from "./menus/dockIntent.ts";
import { tileStatusChip, type MoveUi } from "../../../lib/jiraTileModel.ts";
import { StateChip } from "../DockParts.tsx";
import { statusText } from "../../StatusPill.tsx";
import { Kbd } from "../../projects/ui.tsx";
import { usd } from "../../../lib/cardLifecycle.ts";
import { openLive } from "../detail/cardWorkActions.ts";
import { StateButton, StateCollapse } from "../../tasks/BoardState.tsx";
import type { Blocker } from "../../../lib/blockers.ts";

/** The same steps the Status menu reads (JiraMenuHost.tsx), fetched when a card is picked up so a drop can decide at once. */
function readMoves(t: ProviderTask): Promise<MoveFacts> {
  return TRACKERS.jira.statusOptions(t)
    .then((r) => ({ to: (r.data ?? []).map((x) => ({ status: x.toStatus, asks: !!x.needs?.length, key: x.key })), ok: r.ok, error: r.error }))
    .then((r) => (r.ok ? { to: r.to } : { error: r.error ?? "" }))
    .catch(() => ({ error: "Could not reach the server" }));
}

const NONE: readonly Blocker[] = [];
const flatten = (lanes: readonly JiraLane[]): ProviderTask[] => lanes.flatMap((l) => (l.sub?.length ? flatten(l.sub) : l.cards));

const PRIORITY: Record<NonNullable<ProviderTask["priority"]>, { name: string; tone: string; d: string }> = {
  urgent: { name: "Highest", tone: "var(--error)", d: "M6 12l6-5 6 5M6 18l6-5 6 5" },
  high: { name: "High", tone: "var(--error)", d: "M6 15l6-6 6 6" },
  normal: { name: "Medium", tone: "var(--warning)", d: "M6 10h12M6 15h12" },
  low: { name: "Low", tone: "var(--info)", d: "M6 9l6 6 6-6" },
};

function PriorityMark({ p }: { p: ProviderTask["priority"] }) {
  if (!p) return null;
  const m = PRIORITY[p];
  return (
    <span className="agx-jb-pri" style={{ color: m.tone }} data-tip={tipAttr(`Priority: ${m.name}`)} aria-label={`Priority ${m.name}`} role="img">
      <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={m.d} /></svg>
    </span>
  );
}

/** The inline bar a dropped card shows while its move still waits for a yes. `count` past 1: a batch, named by how many. */

export interface BoardCardProps {
  card: ProviderTask;
  density: BoardDensity;
  /** The column the card sits in: the status chip shows only when the card's status is not it. */
  lane?: string | null;
  /** What the tile's Jira actions need: the next column, the write switch, and the board's own move and assign flows. */
  nextStatus?: string | null;
  writable?: boolean | undefined;
  onMoveNext?: ((card: ProviderTask, to: string) => void) | undefined;
  onAssign?: ((card: ProviderTask) => void) | undefined;
  /** A click on the face: the Assign popover. */
  onFaces?: ((el: HTMLElement, card: ProviderTask) => void) | undefined;
  moveUi?: MoveUi | undefined;
  epicTint: string | undefined;
  /** The board is one epic's page: a sub-task does not repeat the epic chip. */
  epicPage?: boolean;
  blockedBy: readonly Blocker[];
  worker: CardWorker | null;
  /** The card's last agent session, ended in the past two hours with none live after it: what the tile says instead of a worker. */
  ended?: FinishedRun | null | undefined;
  selected: boolean;
  /** Next to the open card: its parent or one of its sub-tasks gets a quiet left bar. */
  family?: FamilyRole | undefined;
  /** Title by key of the cards on the board: the family row names each sub-task with it. */
  titles?: ReadonlyMap<string, string> | undefined;
  /** The `↳ KEY` chip of a sub-task: opens that parent card. */
  onOpenParent?: ((key: string) => void) | undefined;
  onOpen: (e: MouseEvent, id: string) => void;
  onMenu?: ((e: MouseEvent, card: ProviderTask) => void) | undefined;
  /** Picked up to drag it to another column: absent turns dragging off. */
  onPointerDown?: ((e: ReactPointerEvent) => void) | undefined;
  /** This card is the one being lifted right now: it stays in place, dimmed, while a clone follows the pointer. */
  dragging?: boolean;
  /** Part of the multi-select (Ctrl/Cmd+click, Shift+click or `x`): an accent ring and a check in the corner. */
  multiSelected?: boolean;
  /** One of a batch move still waiting for a yes (whether or not this is the card carrying the confirm bar):
   *  dimmed, with a small clock mark, so the whole batch reads as held rather than only the one card with the bar. */
  batchWait?: boolean;
}

function CardView({ card: t, density, lane = null, nextStatus = null, writable, onMoveNext, onAssign, onFaces, moveUi, epicTint, epicPage = false, blockedBy, worker, ended = null, selected, family, titles, onOpenParent, onOpen, onMenu, onPointerDown, dragging, multiSelected, batchWait }: BoardCardProps) {
  const mark = typeMark(t);
  const subs = t.subtasks ?? 0;
  const key = keyOf(t);
  return (
    <div role="listitem" data-jb-card={t.id} tabIndex={0} aria-selected={selected} aria-label={`${key} ${t.title}`}
      className="agx-jb-card" data-mine={t.mine ? "" : undefined} data-needs={worker?.status === "waiting" ? "" : undefined} data-stuck={worker?.status === "stalled" || worker?.status === "errored" ? "" : undefined} data-density={density} data-jb-family={family} data-jb-key={key} data-jb-fam={familyKeyOf(t)} data-jb-drag-source={dragging ? "" : undefined}
      data-jb-multisel={multiSelected ? "" : undefined} data-jb-batch-wait={batchWait ? "" : undefined}
      onClick={(e) => onOpen(e, t.id)}
      /* The middle button opens the card in Jira, as it opens a link in a new tab; Ctrl+click is already multi-select. */
      onMouseDown={(e) => { if (e.button === 1 && t.url) e.preventDefault(); }}
      onAuxClick={(e) => { if (e.button === 1 && t.url) { e.preventDefault(); openExternal(t.url); } }}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onOpen(e as unknown as MouseEvent, t.id); } }}
      onPointerDown={onPointerDown}
      onContextMenu={onMenu ? (e) => onMenu(e, t) : undefined}>
      {onMenu && density === "compact" && (
        <button type="button" className="agx-jb-dots" aria-label={`Menu for ${key}`} aria-haspopup="menu" data-tip={tipAttr("Open, copy or open in Jira - or right-click")}
          onPointerDown={(e) => e.stopPropagation()} onClick={(e) => onMenu(e, t)}><MoreIcon size={ICON.sm} /></button>
      )}
      {multiSelected && <span className="agx-jb-multidot" aria-hidden><DoneIcon size={ICON.xs} /></span>}
      {batchWait && <span className="agx-jb-waitdot" aria-hidden data-tip={tipAttr("Waiting on the batch move")}><ClockIcon size={ICON.xs} /></span>}
      <div className="agx-jb-head">
        <span className="agx-jl-tile" style={{ ["--t" as string]: mark.tone }} data-tip={tipAttr(mark.name)}>{mark.letter}</span>
        <span className="agx-jb-key" data-tip={tipAttr({ name: key, mono: true, text: `${t.issueType || "Card"} · ${t.status}${t.updated > 0 ? ` · moved ${fmtAgo(t.updated)} ago` : ""}` })}>{key}</span>
        {density === "comfortable" && (() => { const chip = tileStatusChip(t.status, lane); return chip ? <StateChip status={chip} color={t.statusColor || undefined} done={t.statusKind === "done"} /> : null; })()}
        {/* Only a date that asks for action now: late, today or tomorrow. A far date on every tile is noise the list mode already carries. */}
        {(() => { const d = t.due && t.statusKind !== "done" ? dueWords(t.due, todayStr(), false) : null;
          return d && (d.tone === "late" || d.tone === "today" || d.text === "Tomorrow")
            ? <span className="agx-jb-due" data-tone={d.tone} data-tip={tipAttr({ name: d.tone === "late" ? "Overdue" : "Due soon", text: `Due ${t.due!.slice(0, 10)}${d.tone === "late" ? `, ${d.text.toLowerCase()}` : ""}` })}>{d.tone === "late" ? "overdue" : `due ${d.text.toLowerCase()}`}</span> : null; })()}
        {density === "comfortable" && (() => { const c = headChips(t, epicPage);
          const epicName = t.epic ? (t.epic.title || t.epic.key) : "";
          return (<>
            {c.parent && t.parent && (
              <button type="button" className="agx-jb-parent" aria-label={`Open parent ${t.parent.key}${t.parent.title ? `, ${t.parent.title}` : ""}`} data-tip={tipAttr({ name: t.parent.key, mono: true, text: `${t.parent.title || "Open the card this sub-task sits under."}${epicName && !epicPage ? ` · Epic: ${epicName}` : ""}` })}
                onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onOpenParent?.(t.parent!.key); }}>↳ {t.parent.title || t.parent.key}</button>
            )}
            {!c.parent && c.epic && (t.parent ?? t.epic) && (
              <span className="agx-jb-epic" style={{ ["--e" as string]: epicTint ?? "var(--text3)" }} data-tip={tipAttr({ name: (t.parent ?? t.epic)!.title || (t.parent ?? t.epic)!.key, detail: (t.parent ?? t.epic)!.key })}>{(t.parent ?? t.epic)!.title || (t.parent ?? t.epic)!.key}</span>
            )}
            {c.parent && c.epic && t.epic && (
              <span className="agx-jb-epic" style={{ ["--e" as string]: epicTint ?? "var(--text3)" }} data-tip={tipAttr({ name: t.epic.title || t.epic.key, detail: t.epic.key })}>{t.epic.title || t.epic.key}</span>
            )}
          </>); })()}
        <span className="agx-jb-gap" />
        {quietDays(t) > 0 && <span className="agx-jb-stale" role="img" aria-label={`No change in ${quietDays(t)} days`} data-tip={tipAttr({ name: `Quiet for ${quietDays(t)} days`, text: `Nothing on this card has changed since ${new Date(t.updated).toLocaleDateString()}.` })}><ClockIcon size={ICON.xs} /></span>}
        {/* Compact has no worker line: the agent's state rides in the header as the same dot the line would lead with. */}
        {density === "compact" && (worker || ended) && (
          /* A live agent's dot brings its tab forward (the tile's own click would open the card); a finished one's lets
             the click through and asks the card to land on Work. */
          <span className="agx-jb-work-dot" role="img" style={{ cursor: "pointer" }}
            onPointerDown={worker ? (e) => e.stopPropagation() : undefined}
            onClick={(e) => { if (worker) { e.stopPropagation(); openLive(null, worker); } else askDock(t.id, "work"); }}
            data-live={worker?.status === "working" ? "" : undefined} data-needs={worker?.status === "waiting" ? "" : undefined} data-stuck={worker?.status === "stalled" || worker?.status === "errored" ? "" : undefined}
            aria-label={worker ? `${worker.title}: ${worker.status === "waiting" ? "needs you" : worker.status}` : "Agent finished lately"}
            data-tip={tipAttr(worker ? { name: worker.title, detail: worker.status === "waiting" ? "needs you" : worker.status, ...(worker.doing ? { text: `Now: ${worker.doing}` } : {}) } : { name: ended!.title, detail: "finished", text: `Its last session ended ${new Date(ended!.at).toLocaleTimeString()}.` })} />
        )}
        {t.flagged && <span className="agx-jb-flag" data-tip={tipAttr("Flagged: an impediment is raised on this card")} aria-label="Flagged" role="img"><FlagIcon size={ICON.xs} /></span>}
        {density === "comfortable" && <PriorityMark p={t.priority} />}
        {density === "compact" && <PeopleFaces people={t.people ?? []} {...(onFaces && writable !== false ? { onPick: (el: HTMLElement) => onFaces(el, t) } : {})} />}
      </div>
      <div className="agx-jb-title" data-tip={tipAttr(t.title)}>{t.title}</div>
      {density === "compact" && <CompactPr card={t} />}
      {density === "comfortable" && (
        <>
          <TileBody card={t} blockedBy={blockedBy} worker={worker} ended={ended} onOpenKey={onOpenParent} onMenu={onMenu} nextStatus={nextStatus} writable={writable !== false} onMoveNext={onMoveNext} onAssign={onAssign} moveUi={moveUi} laneWidth={CARD_W[density]} hideKids />
          {t.children && t.children.length > 0 && <FamilyRows kids={t.children} titles={titles ?? NONE_TITLES} onOpenKey={onOpenParent} />}
          {/* The bottom row of the mockup: points, sub-tasks, then the face at the right. Labels stay, after the sub-tasks. */}
          <div className="agx-jb-foot">
            {t.points != null && <span className="agx-jb-pill" data-tip={tipAttr("Story points")}>{t.points} pt</span>}
            {subs > 0 && !t.children?.length && <span className="agx-jb-pill agx-jb-pill-line" data-tip={tipAttr({ name: `${subs} ${subs === 1 ? "sub-task" : "sub-tasks"}`, text: "Open the card to see and move them." })}>{subs} {subs === 1 ? "subtask" : "subtasks"} <CaretIcon size={ICON.xs} /></span>}
            {/* Two labels and a count: the rest are in the tip, so a card with twelve labels stays one line. */}
            {t.tags.slice(0, 2).map((g) => <span key={g} className="agx-jb-label" data-tip={tipAttr({ name: g, text: "Label" })}>{g}</span>)}
            {t.tags.length > 2 && <span className="agx-jb-label" data-tip={tipAttr({ name: `${t.tags.length - 2} more labels`, text: t.tags.slice(2).join(", ") })}>+{t.tags.length - 2}</span>}
            <span className="agx-jb-gap" />
            <PeopleFaces people={t.people ?? []} {...(onFaces && writable !== false ? { onPick: (el: HTMLElement) => onFaces(el, t) } : {})} />
          </div>
        </>
      )}
    </div>
  );
}
const BoardCard = memo(CardView);
const NONE_TITLES: ReadonlyMap<string, string> = new Map();

/** The placeholder a column draws at the slot a dragged card (or a dragged batch) would land in: the card's own
 *  height, its key and title faint, so the column reads as already open for it rather than waiting on a guess. A
 *  batch shows its count instead — one slot, not a guess at where each of several would land. */
function GhostSlot({ height, keyLabel, title, count }: { height: number; keyLabel: string; title: string; count: number }) {
  return (
    <div className="agx-jb-ghost" style={{ height }} aria-hidden>
      {count > 1 ? <span className="agx-jb-ghost-title">{count} cards</span> : (
        <>
          <span className="agx-jb-key">{keyLabel}</span>
          <span className="agx-jb-ghost-title">{title}</span>
        </>
      )}
    </div>
  );
}

/** The card (or batch) a drag lifts off the board: a plain clone, fixed to the pointer, tilted and shadowed,
 *  standing in for the browser's own drag image (the jank this replaces). A batch of 2+ shows as a stack, with a
 *  count badge. */
function LiftedCard({ card, density, x, y, w, h, tilt, count }: { card: ProviderTask; density: BoardDensity; x: number; y: number; w: number; h: number; tilt: number; count: number }) {
  const mark = typeMark(card);
  return (
    <div className="agx-jb-lift-wrap" aria-hidden style={{ left: x, top: y, width: w, height: h, ["--tilt" as string]: `${tilt}deg` }}>
      {count > 1 && <div className="agx-jb-lift-shadow s2" />}
      {count > 1 && <div className="agx-jb-lift-shadow s1" />}
      <div className="agx-jb-lift">
        <div className="agx-jb-head">
          <span className="agx-jl-tile" style={{ ["--t" as string]: mark.tone }}>{mark.letter}</span>
          <span className="agx-jb-key">{keyOf(card)}</span>
        </div>
        <div className="agx-jb-title" data-density={density}>{card.title}</div>
        {count > 1 && <span className="agx-jb-lift-badge">{count}</span>}
      </div>
    </div>
  );
}

/** The slim bar at the bottom of the board while 2+ cards are selected: how many, a move-to picker and clear. The
 *  same bar the list view's bulk pick uses (`.agx-jbulk`, BulkBar.tsx), with "Move to" in place of its copy/open. */
function SelectionBar({ count, statuses, onMoveTo, onClear, bulk }: { count: number; statuses: SelectOption[]; onMoveTo: (status: string) => void; onClear: () => void; bulk?: ReactNode }) {
  return (
    <div className="agx-jbulk" role="toolbar" aria-label={`${count} cards selected`}>
      <b className="agx-jbulk-n">{count} selected</b>
      <Select value="" className="agx-jbulk-b" title="Move these cards to a status" trigger={<><CaretIcon size={ICON.xs} />Move to</>} options={statuses} onChange={onMoveTo} />
      {bulk}
      <button type="button" className="agx-jbulk-b" onClick={onClear}>Clear <Kbd>Esc</Kbd></button>
    </div>
  );
}

export interface JiraBoardProps {
  /** The board's view id: the bulk bar's Sprint menu reads the sprints of this board. */
  viewId?: string | undefined;
  model: JiraListModel;
  density: BoardDensity;
  lanes?: BoardLanes | undefined;
  selectedId: string | null;
  onOpen: (id: string) => void;
  /** Opens a card by its key (the sub-task chip's parent). */
  onOpenByKey?: (key: string) => void;
  onRowMenu?: ((e: MouseEvent, card: ProviderTask) => void) | undefined;
  /** `s` on the focused row: the Status menu, numbered 1-8. */
  onStatusMenu?: ((el: HTMLElement, card: ProviderTask) => void) | undefined;
  /** A click on a card's face: the Assign popover. */
  onAssignMenu?: ((el: HTMLElement, card: ProviderTask) => void) | undefined;
  /** The board's own width changed: the rail fold rule reads it. */
  onWidth?: ((w: number) => void) | undefined;
  /** Whether this app may change Jira at all: dragging a card to another column is off without it. */
  writable?: boolean;
  /** Where a drop's result (or refusal) is said, the same note the Status menu leaves. */
  onNote?: ((n: FooterNote) => void) | undefined;
  /** Set while a filter narrows the board: the hint over an empty board offers to take it off. */
  onClearFilter?: (() => void) | undefined;
}

/** j / k (and the arrows) move between cards in reading order: down a column, then the next column. */
function moveFocus(e: KeyboardEvent<HTMLDivElement>): void {
  const k = e.key;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const down = k === "j" || k === "ArrowDown";
  const up = k === "k" || k === "ArrowUp";
  if (!down && !up) return;
  const cards = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-jb-card]")];
  const at = cards.indexOf(document.activeElement as HTMLElement);
  const to = cards[at < 0 ? 0 : at + (down ? 1 : -1)];
  if (!to) return;
  e.preventDefault();
  to.focus();
  to.scrollIntoView({ block: "nearest", inline: "nearest" });
}

const FOLD_KEY = "agx.jira.board.folded";
/** A folded lane is kept in the same set as the columns, under its own prefix, so a lane named like a status never folds that column. */
const LANE = "lane:";
function readFolded(): ReadonlySet<string> {
  try { const v: unknown = JSON.parse(localStorage.getItem(FOLD_KEY) ?? "[]"); return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []); } catch { return new Set(); }
}

const OPEN_KEY = "agx.jira.board.opened";
function readOpened(): ReadonlySet<string> {
  try { const v: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]"); return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []); } catch { return new Set(); }
}

export function JiraBoard({ viewId, model, density, lanes = "none", selectedId, onOpen, onOpenByKey, onRowMenu, onStatusMenu, onAssignMenu, onWidth, writable, onNote, onClearFilter }: JiraBoardProps) {
  const raw = useMemo(() => flatten(model.lanes), [model.lanes]);
  /* A card mid-drop shows in the column it was dropped on, while the write is still out; cleared on either answer. */
  const [moved, setMoved] = useState<Record<string, string>>({});
  /* Columns folded to a strip, kept per browser: a Done column of 400 cards is read once, then got out of the way. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => readFolded());
  /* Empty columns start as bars; one opened by hand (or by a drop) is kept here, so it stays open while empty. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => readOpened());
  /* Kept per board (a column opened on one board does not open the same-named empty one on another). */
  const board = model.view?.id ?? "area";
  const keepOpened = useCallback((upd: (was: ReadonlySet<string>) => ReadonlySet<string>) => setOpened((was) => {
    const next = upd(was);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
    return next;
  }), []);
  /* Bars a drop landed on, noted at the drop; they stay open only once the write goes through (not on Cancel, not on a refusal). */
  const droppedOnBar = useRef(new Set<string>());
  const keepTarget = useCallback((status: string) => {
    if (!droppedOnBar.current.delete(status)) return;
    keepOpened((was) => staysOpenAfterDrop(was, openedKey(board, status)));
  }, [board, keepOpened]);
  const toggleFold = useCallback((status: string) => setFolded((was) => {
    const next = new Set(was); if (next.has(status)) next.delete(status); else next.add(status);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
    return next;
  }), []);
  const cards = useMemo(() => (Object.keys(moved).length ? raw.map((t) => (moved[t.id] && moved[t.id] !== t.status ? { ...t, status: moved[t.id]! } : t)) : raw), [raw, moved]);
  const columns = useMemo(() => lanesOf(cards, model.statuses, model.spaces), [cards, model.statuses, model.spaces]);
  const wip = useMemo(() => new Map((model.statuses as readonly ListStatus[]).filter((s) => s.wip).map((s) => [s.status, s.wip!])), [model.statuses]);
  const byId = useMemo(() => new Map(model.cards.map((t) => [t.id, t])), [model.cards]);
  const refs = useRef({ confirmOn: true, model, byId, onNote, resolvedMap: null as Map<string, MoveFacts> | null, over: null as { status: string; index: number } | null });
  refs.current.model = model; refs.current.byId = byId; refs.current.onNote = onNote;
  const blocked = useMemo(() => new Map(model.cards.map((t) => [t.id, blockersOf(t, byId).map((b) => ({ key: keyOf(b), status: b.status }))])), [model.cards, byId]);
  const family = useMemo(() => familyOf(cards, selectedId), [cards, selectedId]);
  const titles = useMemo(() => new Map(cards.map((t) => [keyOf(t), t.title])), [cards]);
  const root = useRef<HTMLDivElement>(null);
  const lit = useFamilyLight(root, cards, selectedId);
  const epicPage = useMemo(() => isEpicPage(cards, lanes), [cards, lanes]);
  const epicTints = useMemo(() => new Map(model.epics.map((e) => [e.key, `var(${epicToneFor(e)})`])), [model.epics]);
  const agents = useSyncExternalStore(onFleet, fleetNow, fleetNow);
  const workers = useMemo(() => new Map(cards.map((t) => [t.id, workerFor(keyOf(t), agents)])), [cards, agents]);
  const ended = useMemo(() => new Map(finishedFor(agents, Date.now()).map((r) => [r.key, r])), [agents]);
  const rows = useMemo(() => {
    if (lanes !== "agent") return laneOf(cards, lanes);
    const state = agentStateOf(agents, Date.now());
    return laneOf(cards, lanes, (t) => state(keyOf(t)));
  }, [cards, lanes, agents]);
  const scroller = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, hidden: 0 });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const o = { scrollLeft: el.scrollLeft, clientWidth: el.clientWidth, columns: columns.length, density };
    const next = { left: el.scrollLeft > 1, hidden: hiddenRight(o) };
    setEdge((cur) => (cur.left === next.left && cur.hidden === next.hidden ? cur : next));
    onWidth?.(el.clientWidth);
  }, [columns.length, density, onWidth]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  /** `s` on the focused card opens its Status menu, `x` toggles it into the selection; anything else is j/k
   *  navigation. */
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "s" && !e.ctrlKey && !e.metaKey && !e.altKey && onStatusMenu) {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-jb-card]");
      const t = el && cards.find((c) => c.id === el.dataset.jbCard);
      if (el && t) { e.preventDefault(); onStatusMenu(el, t); return; }
    }
    if (e.key === "x" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-jb-card]")?.dataset.jbCard;
      if (id) { e.preventDefault(); setSelection((s) => toggleSelected(s, id)); anchorRef.current = id; return; }
    }
    moveFocus(e);
  }, [cards, onStatusMenu]);

  const nextColumn = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: nextColumnLeft({ scrollLeft: el.scrollLeft, clientWidth: el.clientWidth, columns: columns.length, density }), behavior: "smooth" });
  };

  const canDrag = writable !== false;
  const [confirmOn] = useConfirmBoardMoves();
  refs.current.confirmOn = confirmOn;
  /* Ctrl/Cmd+click toggles, Shift+click ranges within a column (anchorRef), Esc or a plain click clears. */
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const anchorRef = useRef<string | null>(null);
  /* The card (or, dragging a selected one with 2+ selected, the whole batch) lifted off the board: which cards,
     where the pointer is, and the steps read once at pick-up for each so a drop can decide at once. `started` is
     the threshold: short of it, the pointer-up still opens the card. */
  const dragRef = useRef<{ cards: ProviderTask[]; movesMap: Map<string, Promise<MoveFacts>>; startX: number; startY: number; offX: number; offY: number; w: number; h: number; started: boolean } | null>(null);
  const suppressClick = useRef(false);
  const edgeRef = useRef<{ dir: -1 | 0 | 1; px: number }>({ dir: 0, px: 0 });
  const rafRef = useRef<number | null>(null);
  const [live, setLive] = useState<{ cardIds: string[]; x: number; y: number; w: number; h: number; tilt: number } | null>(null);
  const [over, setOver] = useState<{ status: string; index: number } | null>(null);
  const [resolvedMap, setResolvedMap] = useState<Map<string, MoveFacts> | null>(null);
  const [pending, setPending] = useState<(PendingMove & { moves: Promise<MoveFacts>; batch?: { cardIds: string[]; movesMap: Map<string, Promise<MoveFacts>> } }) | null>(null);
  const draggedCard = live ? byId.get(live.cardIds[0]!) : undefined;

  /** The tile's move states, from the move the board already runs: in flight, or failed with Jira's own reason. */
  const [moveUi, setMoveUi] = useState<Record<string, MoveUi>>({});
  const setUi = (id: string, ui: MoveUi | null) => setMoveUi((m) => { if (!ui) { if (!(id in m)) return m; const { [id]: _d, ...rest } = m; return rest; } return { ...m, [id]: ui }; });
  const unmove = (id: string) => setMoved((m) => { if (!(id in m)) return m; const { [id]: _drop, ...rest } = m; return rest; });

  const commitMove = (cardId: string, toStatus: string, moves: Promise<MoveFacts>) => {
    void moves.then((mv) => {
      const outcome = dropDecision(mv, toStatus);
      if (!outcome.ok) { unmove(cardId); setUi(cardId, { phase: "failed", to: toStatus, reason: outcome.reason }); refs.current.onNote?.({ ok: false, text: outcome.reason }); return; }
      const opt: StatusOption = { key: outcome.key, label: outcome.toStatus, toStatus: outcome.toStatus, toKind: "open" };
      refs.current.onNote?.({ ok: true, text: "moving…" });
      const t = refs.current.byId.get(cardId);
      if (!t) return;
      setUi(cardId, { phase: "moving", to: outcome.toStatus });
      void TRACKERS.jira.setStatus(t, opt).then((r) => {
        unmove(cardId);
        setUi(cardId, r.ok ? null : { phase: "failed", to: outcome.toStatus, reason: r.error || "Jira refused that" });
        refs.current.onNote?.({ ok: r.ok, text: r.ok ? `now ${outcome.toStatus}` : r.error || "Jira refused that" });
        if (r.ok) keepTarget(outcome.toStatus);
        if (r.ok && r.task) refs.current.model.fold(r.task);
      });
    });
  };

  /* The last batch run, row by row: what the progress dialog and the result toast read. `open` is whether the list is on screen. */
  const [run, setRun] = useState<{ items: MoveItem[]; to: string; rows: Record<string, RunRow>; endedAt: number | null; open: boolean; toast: boolean } | null>(null);
  const setRow = (id: string, row: RunRow) => setRun((r) => (r ? { ...r, rows: { ...r.rows, [id]: row } } : r));
  /** Read-only: the move's screen for one card, through the same transitions read the Status menu uses. */
  const readScreen = (it: MoveItem): Promise<ScreenRead> => {
    const t = refs.current.byId.get(it.id);
    if (!t) return Promise.resolve({ phase: "failed", error: "" });
    return TRACKERS.jira.statusOptions(t).then((r): ScreenRead => (r.ok
      ? { phase: "ok", moves: (r.data ?? []).map((o) => ({ toStatus: o.toStatus, ...(o.needs ? { needs: o.needs } : null), ...(o.fields ? { fields: o.fields } : null) })) }
      : { phase: "failed", error: r.error ?? "" }));
  };
  const itemOf = (c: ProviderTask): MoveItem => ({ id: c.id, key: keyOf(c), title: c.title, from: c.status });

  /** A batch move: the same one-at-a-time call as a single move, in order, each card deciding for itself. A card
   *  whose transition is refused stays put; the others still go. `show`: the progress list opens at once. */
  const commitBatch = async (cardIds: string[], toStatus: string, movesMap: Map<string, Promise<MoveFacts>>, show: boolean) => {
    const items = cardIds.map((id) => refs.current.byId.get(id)).filter((t): t is ProviderTask => !!t).map(itemOf);
    setRun({ items, to: toStatus, rows: Object.fromEntries(items.map((i) => [i.id, { phase: "moving" } as RunRow])), endedAt: null, open: show, toast: false });
    let moved = 0;
    const failed: BatchFailure[] = [];
    for (const id of cardIds) {
      const t = refs.current.byId.get(id);
      const mv = await (movesMap.get(id) ?? Promise.resolve({ error: "" } as MoveFacts));
      const outcome = dropDecision(mv, toStatus);
      if (!outcome.ok) { unmove(id); failed.push({ key: t ? keyOf(t) : id, reason: outcome.reason }); setRow(id, { phase: "failed", reason: outcome.reason }); continue; }
      if (!t) { unmove(id); continue; }
      const opt: StatusOption = { key: outcome.key, label: outcome.toStatus, toStatus: outcome.toStatus, toKind: "open" };
      const r = await TRACKERS.jira.setStatus(t, opt);
      unmove(id);
      if (r.ok) { moved++; keepTarget(toStatus); setRow(id, { phase: "moved" }); if (r.task) refs.current.model.fold(r.task); } else { const reason = r.error || "Jira refused that"; failed.push({ key: keyOf(t), reason }); setRow(id, { phase: "failed", reason }); }
    }
    setRun((r) => (r ? { ...r, endedAt: Date.now(), toast: !r.open } : r));
    refs.current.onNote?.({ ok: failed.length === 0, text: batchResultLine(moved, failed) });
  };

  /** Undo: each moved card goes back to where it stood, through the same decision a move makes. */
  const undoRun = async (ids: string[]) => {
    const r0 = run; if (!r0) return;
    for (const id of ids) {
      const t = refs.current.byId.get(id), from = r0.items.find((i) => i.id === id)?.from;
      if (!t || !from) continue;
      const back = dropDecision(await readMoves({ ...t, status: r0.to }), from);
      if (!back.ok) { setRow(id, { phase: "moved", reason: back.reason }); refs.current.onNote?.({ ok: false, text: `${keyOf(t)}: ${back.reason}` }); continue; }
      const res = await TRACKERS.jira.setStatus({ ...t, status: r0.to }, { key: back.key, label: back.toStatus, toStatus: back.toStatus, toKind: "open" });
      if (res.ok) { setRow(id, { phase: "undone" }); if (res.task) refs.current.model.fold(res.task); } else refs.current.onNote?.({ ok: false, text: `${keyOf(t)}: ${res.error || "Jira refused that"}` });
    }
  };

  /** The dialog's Move: only the cards that can make the step go; the ones that cannot go back where they were. */
  const commitPending = (ids: string[]) => {
    const p = pending; if (!p) return;
    setPending(null);
    if (p.batch) {
      for (const id of p.batch.cardIds) if (!ids.includes(id)) unmove(id);
      void commitBatch(ids, p.to, p.batch.movesMap, true);
    } else commitMove(p.cardId, p.to, p.moves);
  };
  const cancelPending = () => {
    const p = pending; if (!p) return;
    setPending(null);
    droppedOnBar.current.clear();
    if (p.batch) for (const id of p.batch.cardIds) unmove(id);
    else unmove(p.cardId);
  };

  const clearSelection = () => { setSelection(EMPTY_SELECTION); anchorRef.current = null; };

  /* Esc clears the selection — but only when it is not already answering a live drag or a pending drop. */
  useEffect(() => {
    if (!selection.size) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || live || pending) return;
      e.preventDefault();
      clearSelection();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selection, live, pending]);

  /** The tile's "Move to <next column>": one card through the same flow as a drop, so the confirm dialog and the write rules are the board's. */
  const moveOne = (c: ProviderTask, toStatus: string) => {
    if (c.status === toStatus) return;
    setUi(c.id, null);
    const moves = readMoves(c);
    setMoved((m) => ({ ...m, [c.id]: toStatus }));
    if (refs.current.confirmOn) { setPending({ ...startPending(c.id, c.status, toStatus, Date.now()), moves }); return; }
    commitMove(c.id, toStatus, moves);
  };
  const assignOne = (c: ProviderTask) => { onOpen(c.id); askDock(c.id, "assign"); };
  /* The next column that is a step of the flow. A status the board has no column for (Blocked, Won't do) is drawn
     between the steps but is not one: a card in Ready for engineering moved on goes to In development, never to
     Blocked, and a card already in Blocked has no next step to offer. */
  const nextOf = (status: string): string | null => nextFlowStatus(columns.map((x) => x.status), status, model.statuses);

  /** The selection bar's "Move to": the same batch move a drag ends with, without the drag. */
  const moveSelectionTo = (toStatus: string) => {
    const batch = cards.filter((c) => selection.has(c.id));
    const eligible = batch.filter((c) => c.status !== toStatus);
    if (!eligible.length) return;
    const movesMap = new Map(eligible.map((c) => [c.id, readMoves(c)] as const));
    setMoved((m) => { const next = { ...m }; for (const c of eligible) next[c.id] = toStatus; return next; });
    const primary = eligible[0]!;
    if (refs.current.confirmOn || eligible.length > 1) {
      setPending({ ...startPending(primary.id, primary.status, toStatus, Date.now()), moves: movesMap.get(primary.id)!, batch: eligible.length > 1 ? { cardIds: eligible.map((c) => c.id), movesMap } : undefined });
      return;
    }
    if (eligible.length > 1) void commitBatch(eligible.map((c) => c.id), toStatus, movesMap, false);
    else commitMove(primary.id, toStatus, movesMap.get(primary.id)!);
  };

  /** A plain click opens (and clears any selection); Ctrl/Cmd+click toggles; Shift+click ranges within `order`
   *  (this card's own column). A click right after a drag, or on the card its own move is still waiting on, does
   *  neither. */
  const onCardClick = (e: MouseEvent, id: string, order: readonly string[]) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (pending && (pending.cardId === id || pending.batch?.cardIds.includes(id))) return;
    if (e.shiftKey) { setSelection((s) => rangeSelected(order, anchorRef.current ?? (s.size ? id : selectedId ?? id), id)); anchorRef.current = id; return; }
    if (e.ctrlKey || e.metaKey) { setSelection((s) => toggleSelected(seedWithOpen(s, selectedId, id), id)); anchorRef.current = id; return; }
    if (selection.size) clearSelection();
    onOpen(id);
  };

  /** The column (if any) under `(x, y)`, and the slot in it, by the cards actually drawn there (the dragged cards,
   *  still showing dimmed at their old place, never count toward their own slot). */
  const hoveredSlot = (x: number, y: number): { status: string; index: number } | null => {
    const colEl = document.elementsFromPoint(x, y).find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.jbDropcol !== undefined);
    if (!colEl) return null;
    const draggedIds = new Set(dragRef.current?.cards.map((c) => c.id) ?? []);
    const rects: CardTop[] = [...colEl.querySelectorAll<HTMLElement>("[data-jb-card]")]
      .filter((el) => !draggedIds.has(el.dataset.jbCard ?? ""))
      .map((el) => { const r = el.getBoundingClientRect(); return { id: el.dataset.jbCard ?? "", top: r.top, height: r.height }; });
    return { status: colEl.dataset.jbDropcol!, index: slotIndex(y, rects) };
  };

  const finishDrop = (d: NonNullable<typeof dragRef.current>, hit: { status: string; index: number }) => {
    const eligible = d.cards.filter((c) => c.status !== hit.status);
    if (!eligible.length) return;
    let toMove = eligible;
    if (eligible.every((c) => refs.current.resolvedMap?.has(c.id))) {
      const decided = eligible.map((c) => ({ c, outcome: dropDecision(refs.current.resolvedMap!.get(c.id)!, hit.status) }));
      toMove = dropTargets(eligible, decided.map((x) => x.outcome.ok));
      if (!toMove.length) { refs.current.onNote?.({ ok: false, text: (decided[0]!.outcome as { ok: false; reason: string }).reason }); return; }
    }
    setMoved((m) => { const next = { ...m }; for (const c of toMove) next[c.id] = hit.status; return next; });
    if (barred(hit.status)) droppedOnBar.current.add(hit.status);
    const primary = toMove[0]!;
    if (refs.current.confirmOn || toMove.length > 1) {
      setPending({ ...startPending(primary.id, primary.status, hit.status, Date.now()), moves: d.movesMap.get(primary.id)!, batch: toMove.length > 1 ? { cardIds: toMove.map((c) => c.id), movesMap: d.movesMap } : undefined });
      return;
    }
    if (toMove.length > 1) void commitBatch(toMove.map((c) => c.id), hit.status, d.movesMap, false);
    else commitMove(primary.id, hit.status, d.movesMap.get(primary.id)!);
  };

  /** Picked up to drag it to another column; off without write access. A card that is one of 2+ selected drags the
   *  whole selection; otherwise just itself. Pointer events, not native HTML5 drag, so the lifted card is this
   *  app's own (no browser drag image) and the column it lands on opens a slot for it. */
  const startDrag = (e: ReactPointerEvent, t: ProviderTask) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const ids = new Set(dragBatchIds(cards.map((c) => c.id), selection, t.id));
    const batch = cards.filter((c) => ids.has(c.id));
    const movesMap = new Map(batch.map((c) => [c.id, readMoves(c)] as const));
    refs.current.resolvedMap = null; setResolvedMap(null);
    void Promise.all([...movesMap.entries()].map(async ([id, p]) => [id, await p] as const)).then((entries) => {
      const m = new Map(entries);
      refs.current.resolvedMap = m; setResolvedMap(m);
    });
    dragRef.current = { cards: batch, movesMap, startX: e.clientX, startY: e.clientY, offX: e.clientX - rect.left, offY: e.clientY - rect.top, w: rect.width, h: rect.height, started: false };

    const tick = () => {
      const el = scroller.current;
      if (el && edgeRef.current.dir) el.scrollLeft += edgeRef.current.dir * edgeRef.current.px;
      rafRef.current = requestAnimationFrame(tick);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onEsc, true);
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      edgeRef.current = { dir: 0, px: 0 };
    };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX, dy = ev.clientY - d.startY;
      if (!d.started) {
        if (!pastThreshold(dx, dy)) return;
        d.started = true;
        suppressClick.current = true;
        rafRef.current = requestAnimationFrame(tick);
        setLive({ cardIds: d.cards.map((c) => c.id), x: ev.clientX - d.offX, y: ev.clientY - d.offY, w: d.w, h: d.h, tilt: reducedMotion() ? 0 : LIFT_TILT_DEG });
      } else {
        setLive((cur) => (cur ? { ...cur, x: ev.clientX - d.offX, y: ev.clientY - d.offY } : cur));
      }
      const hit = hoveredSlot(ev.clientX, ev.clientY);
      refs.current.over = hit;
      setOver(hit);
      const b = scroller.current?.getBoundingClientRect();
      edgeRef.current = b ? edgeScroll(ev.clientX, { left: b.left, right: b.right }) : { dir: 0, px: 0 };
    };
    const onUp = () => {
      stop();
      const d = dragRef.current;
      dragRef.current = null;
      setLive(null);
      const hit = refs.current.over;
      refs.current.over = null;
      setOver(null);
      if (d?.started && hit) finishDrop(d, hit);
    };
    const onEsc = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      stop();
      dragRef.current = null;
      setLive(null);
      refs.current.over = null;
      setOver(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onEsc, true);
  };

  /** Whether `status` would take at least one of the dragged cards (null, still reading, says no): each decides on
   *  its own steps, so a batch can be partly allowed. Refused only once every one of them is a known no. */
  const dragIds = live?.cardIds;
  const allowedMemo = useMemo(() => new Map<string, boolean>(), [dragIds, resolvedMap]);
  const colAllowed = (status: string): boolean => {
    if (!dragIds) return false;
    const hit = allowedMemo.get(status);
    if (hit !== undefined) return hit;
    const ok = dragIds.some((id) => {
      const c = refs.current.byId.get(id);
      const mv = resolvedMap?.get(id);
      return !!c && c.status !== status && !!mv && dropDecision(mv, status).ok;
    });
    allowedMemo.set(status, ok);
    return ok;
  };
  const colRefused = (status: string): boolean => {
    if (!live || !resolvedMap) return false;
    const eligible = live.cardIds.filter((id) => refs.current.byId.get(id)?.status !== status);
    if (!eligible.length || !eligible.every((id) => resolvedMap.has(id))) return false;
    return eligible.every((id) => !dropDecision(resolvedMap.get(id)!, status).ok);
  };

  const counts = new Map(columns.map((c) => [c.status, c.cards.length]));
  const barred = (status: string) => startsCollapsed({ count: counts.get(status) ?? 0, folded: folded.has(status), opened: opened.has(openedKey(board, status)) });
  const dragOpen = (status: string) => !!live && opensForDrag({ collapsed: barred(status), allowed: colAllowed(status) });
  /* Shown = open by itself or opened by a drag. */
  const shown = (status: string) => !barred(status) || dragOpen(status);
  /** The bar opens (kept open), an open column folds: one rule for the click, Enter and Space. */
  const toggleCol = (status: string, all: readonly string[], shift: boolean) => {
    const key = openedKey(board, status);
    if (shift) {
      const r = shiftToggle({ status, all, barred: barred(status), folded, opened, laneKey: LANE, board });
      setFolded(r.folded); keepOpened(() => pruneOpened(r.opened, board, all));
      try { localStorage.setItem(FOLD_KEY, JSON.stringify([...r.folded])); } catch { /* private mode */ }
      return;
    }
    const next = new Set(folded);
    if (barred(status)) { next.delete(status); keepOpened((was) => new Set([...was, key])); } else { next.add(status); keepOpened((was) => { const n = new Set(was); n.delete(key); return n; }); }
    setFolded(next);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
  };

  /** A column's cards, with the ghost slot (one card, or a batch's count) spliced in at the drop index while it is
   *  the one being hovered and allowed. */
  const cardsOf = (status: string, list: readonly ProviderTask[]) => {
    const here = over?.status === status ? over : null;
    const items = list.map((t) => (
      <BoardCard key={t.id} card={t} density={density} lane={status} nextStatus={nextOf(status)} writable={writable} onMoveNext={moveOne} onAssign={assignOne} onFaces={onAssignMenu} moveUi={moveUi[t.id]} selected={t.id === selectedId} family={family.get(t.id)} titles={titles} onOpenParent={onOpenByKey}
        epicPage={epicPage} epicTint={(t.epic ?? t.parent) ? epicTints.get((t.epic ?? t.parent)!.key) : undefined}
        blockedBy={blocked.get(t.id) ?? NONE} worker={workers.get(t.id) ?? null} ended={ended.get(keyOf(t).toUpperCase()) ?? null} onOpen={(e, id) => onCardClick(e, id, list.map((c) => c.id))} onMenu={onRowMenu}
        onPointerDown={canDrag ? (e) => startDrag(e, t) : undefined} dragging={!!live && live.cardIds.includes(t.id)} multiSelected={selection.has(t.id)}
        batchWait={!!pending?.batch && (pending.cardId === t.id || pending.batch.cardIds.includes(t.id))}
        />
    ));
    if (here && live && colAllowed(status)) {
      items.splice(Math.min(here.index, items.length), 0, <GhostSlot key="jb-ghost" height={live.h} keyLabel={draggedCard ? keyOf(draggedCard) : ""} title={draggedCard?.title ?? ""} count={live.cardIds.length} />);
    }
    return items;
  };

  const cell = (status: string, list: readonly ProviderTask[]) => !shown(status) ? (
    <div key={status} className="agx-jb-col" data-folded="" aria-hidden data-jb-dropcol={canDrag ? status : undefined} data-jb-refused={colRefused(status) ? "" : undefined} />
  ) : (
    <div key={status} className="agx-jb-col" role="list" aria-label={`${status}, ${list.length} ${list.length === 1 ? "card" : "cards"}`} data-jb-dragopen={barred(status) ? "" : undefined}
      data-jb-dropcol={canDrag ? status : undefined} data-jb-refused={colRefused(status) ? "" : undefined}>
      {barred(status) && <div className="agx-jb-droptip" aria-hidden>Drop to move to {statusText(status)}</div>}
      {cardsOf(status, list)}
    </div>
  );

  const colHead = (col: JiraLane) => {
    const limit = wip.get(col.status);
    const over = limit !== undefined && col.cards.length > limit;
    const fold = !shown(col.status);
    const n = col.cards.length;
    const pts = col.cards.reduce((sum, t) => sum + (t.points ?? 0), 0);
    const mine = col.cards.filter((t) => t.mine).length;
    const quiet = col.cards.filter((t) => quietDays(t) > 0).length;
    const agented = col.cards.map((t) => workers.get(t.id)).filter(Boolean);
    const waiting = agented.filter((w) => w!.status === "waiting").length;
    const stuck = agented.filter((w) => w!.status === "stalled" || w!.status === "errored").length;
    const countTip = tipAttr({ name: `${n} ${n === 1 ? "card" : "cards"}`, detail: col.status, text: [pts ? `${pts} points` : "", mine ? `${mine} assigned to you` : "", quiet ? `${quiet} quiet for 14+ days` : "", agented.length ? `${agented.length} with an agent${waiting ? ` (${waiting} waiting on you)` : ""}${stuck ? ` (${stuck} stalled or errored)` : ""}, ${usd(agented.reduce((m, w) => m + w!.cost, 0))} so far` : "", limit !== undefined ? `limit ${limit}` : ""].filter(Boolean).join(" · ") || undefined });
    return (
      <header key={col.status} className="agx-jb-col agx-jb-colhead" data-folded={fold ? "" : undefined} data-jb-dragopen={barred(col.status) && !fold ? "" : undefined}
        role="button" tabIndex={0} aria-expanded={!fold} aria-label={fold ? `Open ${col.status}` : `Collapse ${col.status}`}
        onClick={(e) => toggleCol(col.status, columns.map((c) => c.status), e.shiftKey)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCol(col.status, columns.map((c) => c.status), e.shiftKey); } }}
        data-tip={tipAttr({ name: fold ? "Open this column" : "Collapse this column", detail: col.status, text: fold ? "Brings its cards back. Shift-click opens every column." : "Keeps the column as a thin bar with its count. Shift-click collapses every other column." })}>
        <span className="agx-jb-fold" aria-hidden><CaretIcon size={ICON.xs} /></span>
        <span className="agx-jl-dot" style={{ ["--d" as string]: col.color ?? "var(--text4)" }} />
        <span className="agx-jb-colname" data-tip={tipAttr(col.status)}>{statusText(col.status)}</span>
        <span className="agx-jb-gap" />
        <span className="agx-jb-count" data-tip={countTip}>{n}</span>
        {/* A column holding an agent stopped on you says so before its cards scroll into view. */}
        {waiting > 0 && <span className="agx-jb-colneeds" role="img" aria-label={`${waiting} waiting on you`} data-tip={countTip} />}
        {/* Nobody waiting but an agent stalled or errored: the dot in red, the next thing worth a look. */}
        {waiting === 0 && stuck > 0 && <span className="agx-jb-colneeds" data-stuck="" role="img" aria-label={`${stuck} stalled or errored`} data-tip={countTip} />}
        {/* Nobody waiting or stuck but agents at work: the same dot in green, so a busy column reads as busy from across the board. */}
        {waiting === 0 && stuck === 0 && agented.length > 0 && <span className="agx-jb-colneeds" data-live="" role="img" aria-label={`${agented.length} with an agent`} data-tip={countTip} />}
        {limit !== undefined && (
          <span className="agx-jb-wip" data-over={over ? "" : undefined} data-tip={tipAttr({ name: "Work-in-progress limit", detail: `${col.cards.length} of ${limit}${over ? ", over the limit" : ""}` })}>WIP {limit}</span>
        )}
      </header>
    );
  };

  return (
    <div ref={root} data-testid="jira-board" className="agx-jb" onPointerOver={lit.over} onPointerLeave={lit.out} onFocus={lit.over} onBlur={lit.out} data-density={density} data-jb-dragging={live ? "" : undefined} style={{ ["--jb-w" as string]: `${CARD_W[density]}px` }}>
      {/* Empty, collapses: one hint for the whole board, never a dashed box per column; the drop zone is the column itself. */}
      {cards.length === 0 && columns.length > 0 && <div className="agx-jb-hint" role="status">{onClearFilter ? <>No card matches the filter.<StateButton onClick={onClearFilter}>Clear filter</StateButton></> : canDrag ? "No cards on this board yet. Drop one on a column to move it here." : "No cards on this board."}</div>}
      <div ref={scroller} className={`agx-jb-scroll${lanes === "none" ? " agx-jb-percol" : ""}`} onScroll={measure} onKeyDown={onKeyDown} role="group" aria-label="Board columns">
        {lanes === "none" ? columns.map((col) => (
          <div key={col.status} className="agx-jb-col agx-jb-colbox" data-testid="jira-board-col" data-folded={shown(col.status) ? undefined : ""} data-jb-dragopen={barred(col.status) && shown(col.status) ? "" : undefined}
            /* A folded column still takes a drop: the strip is the column. */
            data-jb-dropcol={canDrag && !shown(col.status) ? col.status : undefined} data-jb-refused={!shown(col.status) && colRefused(col.status) ? "" : undefined}>
            {colHead(col)}
            {shown(col.status) && <div className="agx-jb-cards agx-scroll" role="list" aria-label={`${col.status}, ${col.cards.length} ${col.cards.length === 1 ? "card" : "cards"}`}
              data-jb-dropcol={canDrag ? col.status : undefined} data-jb-refused={colRefused(col.status) ? "" : undefined}>
              {barred(col.status) && <div className="agx-jb-droptip" aria-hidden>Drop to move to {statusText(col.status)}</div>}
              {cardsOf(col.status, col.cards)}
              {col.cards.length === 0 && !barred(col.status) && <StateCollapse />}
            </div>}
          </div>
        )) : (
        <>
        <div className="agx-jb-heads">
          {columns.map(colHead)}
        </div>
        {rows.map((row) => {
          const byStatus = new Map(lanesOf(row.cards, model.statuses).map((l) => [l.status, l.cards]));
          return (
            <section key={row.id} className="agx-jb-lane" aria-label={row.label ? `${row.label}, ${row.cards.length} cards` : "Cards"}>
              {row.label && (
                <button type="button" className="agx-jb-lanehead" aria-expanded={!folded.has(LANE + row.id)} onClick={() => toggleFold(LANE + row.id)}
                  data-tip={tipAttr({ name: folded.has(LANE + row.id) ? "Show this lane" : "Fold this lane", detail: `${row.cards.length} ${row.cards.length === 1 ? "card" : "cards"}` })}>
                  <span className="agx-jb-fold" data-folded={folded.has(LANE + row.id) ? "" : undefined} aria-hidden><CaretIcon size={ICON.xs} /></span>
                  <span className="agx-jb-trunc">{row.label}</span><span className="agx-jb-count">{row.cards.length}</span>
                </button>
              )}
              {!folded.has(LANE + row.id) && <div className="agx-jb-row">{columns.map((col) => cell(col.status, byStatus.get(col.status) ?? []))}</div>}
            </section>
          );
        })}
        </>
        )}
      </div>
      <span className="agx-jb-fade l" data-on={edge.left ? "" : undefined} aria-hidden />
      <span className="agx-jb-fade r" data-on={edge.hidden > 0 ? "" : undefined} aria-hidden />
      {edge.hidden > 0 && (
        <button type="button" className="agx-jb-more" onClick={nextColumn}
          aria-label={`${edge.hidden} more ${edge.hidden === 1 ? "column" : "columns"}: scroll to the next`}
          data-tip={tipAttr({ name: "Scroll to the next column", detail: `${edge.hidden} past the edge` })}>
          +{edge.hidden} {edge.hidden === 1 ? "column" : "columns"} <ArrowRightIcon size={ICON.xs} />
        </button>
      )}
      {pending && (() => {
        const ids = pending.batch?.cardIds ?? [pending.cardId];
        const items = ids.map((id) => byId.get(id)).filter((t): t is ProviderTask => !!t).map(itemOf);
        const single = !pending.batch;
        return <MoveConfirmDialog key={pending.cardId} items={items} to={pending.to} moves={pending.batch?.movesMap ?? new Map([[pending.cardId, pending.moves]])} readScreen={readScreen}
          next={single && items[0] ? nextOf(items[0].from) : null} onCancel={cancelPending} onMove={commitPending} onDontAsk={single ? () => setConfirmBoardMoves(false) : undefined} />;
      })()}
      {run?.open && <MoveRunDialog items={run.items} to={run.to} rows={run.rows} endedAt={run.endedAt} onUndo={(ids) => void undoRun(ids)}
        onClose={() => setRun((r) => (r ? { ...r, open: false, toast: runDone(Object.values(r.rows)) } : r))} />}
      {run && !run.open && run.toast && <MoveResultToast rows={Object.values(run.rows)} onShow={() => setRun((r) => (r ? { ...r, open: true, toast: false } : r))} onDismiss={() => setRun((r) => (r ? { ...r, toast: false } : r))} />}
      {live && draggedCard && <LiftedCard card={draggedCard} density={density} x={live.x} y={live.y} w={live.w} h={live.h} tilt={live.tilt} count={live.cardIds.length} />}
      {canDrag && selection.size >= 2 && (
        <SelectionBar count={selection.size} statuses={statusOptions(columns.map((col) => col.status), model.statuses)} onMoveTo={moveSelectionTo} onClear={clearSelection}
          bulk={<BulkActions picked={model.cards.filter((t) => selection.has(t.id))} board={viewId ?? ""} context={model.context} epics={model.epics} writable={!!writable} onDone={model.refresh} />} />
      )}
    </div>
  );
}
