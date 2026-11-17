/*
 * One card of the list: a soft row, 52 high at least, two lines. Line one is the title, line two the key and what the card
 * carries (blocked, labels, sub-tasks, comments). The columns after it are the Sprint-or-Epic, the pull request, who is on it,
 * the due date and the points; which of them exist is `cols`, decided by the width. The row has no status chip — the lane says
 * it, and a lane that does not (a grouping other than status) gives each row a quiet dot instead; a sub-task opened under a
 * parent that is not its lane wears the card's own chip.
 *
 * The first column is a gutter on every row, holding the selection checkbox and the chevron as two fixed 20px slots side by
 * side: a parent whose card says it has more sub-tasks than the lane draws puts its chevron there, so opening one moves no
 * column, and neither slot moves when the other control appears. The pull request chip reads the project's one `/jira/prs` search through
 * cardPrStore (a cache shared with the menus and the dock), so forty rows are one request.
 */
import { memo, useState, useSyncExternalStore, type DragEvent, type MouseEvent } from "react";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import { cardPrInk, cardPrTint, pickCardPr, sortedCardPrs, type CardPr } from "../../../lib/cardPrPick.ts";
import { cardPrsOf, cardPrVersion, onCardPrs } from "../../../lib/cardPrStore.ts";
import { cardChecksVersion, checksForUrl, ciChipFor, finishedFor, fleetNow, onCardChecks, onFleet, workerFor } from "../../../lib/jiraCardWork.ts";
import { fmtAgo } from "../../../lib/format.ts";
import { checksOf } from "../../../lib/paneChip.ts";
import { CaretIcon, CheckboxIcon, CommentIcon, CrossIcon, FlagIcon, PullRequestIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { openPr, openPrs, prRefFromUrl } from "../../../lib/openPrs.ts";
import { dueWords } from "../../../lib/taskGrammar.ts";
import { quietDays } from "./model.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { ContextMenu, MenuItem } from "../../ContextMenu.tsx";
import { StateChip } from "../DockParts.tsx";
import { isSubtask, keyOf, progressOf, type Cols } from "./laneModel.ts";
import { PeopleFaces } from "./PeopleFaces.tsx";
import { openLive } from "../detail/cardWorkActions.ts";
import { askDock } from "./menus/dockIntent.ts";
import { ChangedMark } from "./ChangedMark.tsx";
import { blockerWords, type Blocker } from "../../../lib/blockers.ts";

/** Story, Bug, Task, Sub-task and Epic have a letter and a tone; any other type wears its first letter in the quiet one. */
const TYPE_TONE: Record<string, string> = { story: "var(--success)", bug: "var(--error)", task: "var(--info)", epic: "var(--text)" };
export function typeMark(t: Pick<ProviderTask, "issueType">): { letter: string; tone: string; name: string } {
  const name = t.issueType || "Task";
  if (isSubtask(t)) return { letter: "s", tone: "var(--text3)", name };
  return { letter: name.charAt(0).toUpperCase(), tone: TYPE_TONE[name.toLowerCase()] ?? "var(--text3)", name };
}

const SubIcon = () => (
  <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 4v9a3 3 0 0 0 3 3h9M15 13l3 3-3 3" />
  </svg>
);

const prWord = (p: CardPr): string => (p.draft ? "Draft" : p.state === "MERGED" ? "Merged" : p.state === "CLOSED" ? "Closed" : "Open");
function openPull(p: CardPr): void {
  const ref = prRefFromUrl(p.url);
  if (ref) openPr(ref.repo, p.number);
  else openPrs(String(p.number), p.state === "OPEN" ? "open" : "all");
}

/** The pull request of a card: one chip, "+n" when there are more, and a menu to pick one of them. */
export function Pr({ card }: { card: ProviderTask }) {
  useSyncExternalStore(onCardPrs, cardPrVersion, cardPrVersion);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const pick = pickCardPr(cardPrsOf(card.id, keyOf(card), "", "", "jira")?.prs);
  if (pick.kind === "none") return null;
  const shown = pick.kind === "one" ? pick.pr : pick.primary;
  const more = pick.kind === "many" ? pick.rest.length : 0;
  const tint = cardPrInk(shown);
  return (
    <>
      <button type="button" className="agx-jl-pr" style={{ ["--c" as string]: tint }}
        aria-label={`${prWord(shown)} pull request #${shown.number}${more ? `, and ${more} more` : ""}`}
        data-tip={tipAttr({ name: `${prWord(shown)} pull request`, detail: `#${shown.number}`, ...(shown.title ? { text: shown.title } : {}), hint: { text: more ? "Pick one of the pull requests" : "Open it here" } })}
        onClick={(e) => {
          e.stopPropagation();
          if (pick.kind === "many") { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }); } else openPull(shown);
        }}
        onContextMenu={(e) => e.stopPropagation()}>
        <PullRequestIcon size={ICON.xs} />
        <span className="tabular-nums">#{shown.number}</span>
        {more > 0 && <span style={{ opacity: 0.7 }}>+{more}</span>}
      </button>
      {menu && pick.kind === "many" && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {sortedCardPrs([pick.primary, ...pick.rest]).map((p) => (
            <MenuItem key={p.number} onClick={() => { setMenu(null); openPull(p); }}>
              <span className="flex items-center gap-1.5 min-w-0 w-full">
                <span className="shrink-0" style={{ width: 8, height: 8, borderRadius: 999, background: cardPrTint(p) }} />
                <span className="tabular-nums font-mono shrink-0">#{p.number}</span>
                <span className="truncate" style={{ color: "var(--text3)" }}>{p.title}</span>
              </span>
            </MenuItem>
          ))}
        </ContextMenu>
      )}
    </>
  );
}

/** The state of the checks on a card's open pull request, from what the stores already hold; "unknown" with no open PR. */
export function cardCi(t: ProviderTask): "failing" | "passing" | "running" | "unknown" {
  const pick = pickCardPr(cardPrsOf(t.id, keyOf(t), "", "", "jira")?.prs);
  const pr = pick.kind === "none" ? null : pick.kind === "one" ? pick.pr : pick.primary;
  if (!pr || pr.state !== "OPEN") return "unknown";
  const st = checksOf(checksForUrl(pr.url)).state;
  return st === "failing" ? "failing" : st === "passing" ? "passing" : st === "running" ? "running" : "unknown";
}

const CI_PILL = { passing: ["g", "CI pass"], running: ["y", "CI running"], failing: ["r", "CI fail"], "none-read-yet": ["", "CI not read"], error: ["", "CI unknown"] } as const;

/** The PR column: the chip, then the checks as the watch last read them. No review word: the card carries no review data. */
export function PrCell({ card }: { card: ProviderTask }) {
  useSyncExternalStore(onCardPrs, cardPrVersion, cardPrVersion);
  useSyncExternalStore(onCardChecks, cardChecksVersion, cardChecksVersion);
  const pick = pickCardPr(cardPrsOf(card.id, keyOf(card), "", "", "jira")?.prs);
  if (pick.kind === "none") return <span className="agx-jl-sm" style={{ color: "var(--text3)", fontFamily: "var(--jm-mono)", fontSize: 11 }}>no PR</span>;
  const pr = pick.kind === "one" ? pick.pr : pick.primary;
  const chip = pr.state === "OPEN" ? ciChipFor(pr.url) : null;
  const ci = chip ? (chip.loading ? (["", "CI loading"] as const) : CI_PILL[checksOf(chip.read).state]) : null;
  return (
    <div className="agx-jl-prs">
      <Pr card={card} />
      {ci && <span className={`agx-jl-pill ${ci[0]}`}>{ci[1]}</span>}
      {pr.state === "MERGED" && <span className="agx-jl-pill p">merged</span>}
    </div>
  );
}

const dollars = (usd: number): string => `$${usd.toFixed(2)}`;
/** The agent column: the live session that names this card and what it has cost; nothing when no session does. */
export function AgentCell({ card, quiet = false }: { card: ProviderTask; quiet?: boolean }) {
  const agents = useSyncExternalStore(onFleet, fleetNow, fleetNow);
  const w = workerFor(keyOf(card), agents);
  if (!w) {
    // An agent that left in the past two hours still says so, as the board tile does: the same finishedFor window.
    const key = keyOf(card).toUpperCase();
    const r = finishedFor(agents, Date.now()).find((f) => f.key === key);
    if (r) return (
      /* No stopPropagation: the row's own click opens the card, and this asks it to land on Work. */
      <div className="agx-jl-agent" role="button" tabIndex={-1} style={{ cursor: "pointer" }} onClick={() => askDock(key, "work")}
        data-tip={tipAttr({ name: r.title, detail: "ended", text: `Its last session ended ${new Date(r.at).toLocaleTimeString()}, ${dollars(r.cost)} in all. Click to read what it did.` })}>
        <div className="l1"><span className="agx-jl-sm" style={{ color: "var(--text3)" }}>finished {fmtAgo(r.at)} ago</span><span className="sm">{dollars(r.cost)}</span></div>
      </div>
    );
    return quiet ? null : <span className="agx-jl-sm" style={{ color: "var(--text3)", fontFamily: "var(--jm-mono)", fontSize: 11 }}>no worker</span>;
  }
  const live = w.status === "working";
  return (
    <div className="agx-jl-agent" role="button" tabIndex={-1} style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); openLive(null, w); }}
      data-tip={tipAttr({ name: w.title, detail: `${w.status}${w.model ? ` · ${w.model}` : ""}`, text: `${w.doing ? `Now: ${w.doing}. ` : ""}${dollars(w.cost)} so far. Click to bring its tab forward.` })}>
      <div className="l1">
        {live ? <span className="agx-jl-live" /> : <span className={w.status === "waiting" ? "agx-jl-pill y" : w.status === "stalled" || w.status === "errored" ? "agx-jl-pill r" : "agx-jl-pill"}>{w.status === "waiting" ? "needs you" : w.status}</span>}
        {live && <span className="agx-jl-trunc">{w.title}</span>}
        <span className="sm">{dollars(w.cost)}</span>
      </div>
    </div>
  );
}

export interface DragRow {
  edge: "top" | "bottom" | null;
  onStart: () => void; onEnd: () => void;
  onOver: (e: DragEvent<HTMLElement>) => void; onDrop: (e: DragEvent<HTMLElement>) => void;
}

export interface JiraRowProps {
  card: ProviderTask;
  cols: Cols;
  /** The third column's content: the sprint, or the epic of the card. */
  third: { text: string } | null;
  today: string;
  selected: boolean;
  /** The one row a Tab reaches; the arrow keys move between the others. */
  tabbable: boolean;
  /** A sub-task drawn under its parent. */
  nested?: boolean;
  /** A parent's own sub-tasks it can open: the chevron. Absent when it has none the lane does not already draw. */
  open?: { expanded: boolean; count: number; onToggle: () => void } | null;
  /** A sub-task under a parent whose lane is not its own: that lane cannot say its status, so the chip does. */
  chip?: boolean;
  /** The lane does not say the status: a quiet dot does. */
  dot?: { color: string | undefined; name: string } | null;
  /** The board's statuses in workflow order: the progress bar under the key reads the card's place in them. */
  statuses?: readonly { status: string }[];
  /** Where the card's status can be changed from: the pill opens the card menu there. */
  onStatus?: ((e: MouseEvent, card: ProviderTask) => void) | undefined;
  /** Sub-tasks the row has open under it (done of all), for the ring beside the progress bar. */
  ring?: { done: number; of: number } | null;
  /** Keys of the unfinished cards this one waits on. */
  blockedBy: readonly Blocker[];
  drag?: DragRow | undefined;
  onOpen: (id: string) => void;
  onMenu?: ((e: MouseEvent, card: ProviderTask) => void) | undefined;
  /** A looked-up card is kept off the board for this visit only; the row offers to forget it. */
  onForget?: (() => void) | undefined;
  /** Picked for a bulk action (x, or the box itself); absent where bulk picking is off (the board). */
  picked?: boolean | undefined;
  onPick?: (() => void) | undefined;
}

function RowView({ card: t, cols, third, today, selected, tabbable, nested, open, chip, dot, blockedBy, statuses = [], onStatus, ring, drag, onOpen, onMenu, onForget, picked, onPick }: JiraRowProps) {
  const mark = typeMark(t);
  const done = t.statusKind === "done";
  /* A boolean snapshot, so a fleet tick re-renders only the rows whose answer changed. */
  const needs = useSyncExternalStore(onFleet, () => workerFor(keyOf(t), fleetNow())?.status === "waiting", () => false);
  const stuck = useSyncExternalStore(onFleet, () => { const s = workerFor(keyOf(t), fleetNow())?.status; return s === "stalled" || s === "errored"; }, () => false);
  const due = t.due ? dueWords(t.due, today, done) : null;
  const subs = t.subtasks ?? 0;
  const prog = nested ? null : progressOf(t, statuses);
  const sp = [third?.text, t.sprint && third?.text !== t.sprint ? t.sprint : null, due && due.tone !== "none" && due.tone !== "done" ? `due ${due.text}` : null, t.points != null ? `${t.points} pts` : null, quietDays(t) > 0 ? `quiet ${quietDays(t)} d` : null].filter(Boolean);
  return (
    <div role="row" data-jl-row={t.id} data-done={done ? "" : undefined} data-needs={needs ? "" : undefined} data-stuck={stuck ? "" : undefined} tabIndex={tabbable ? 0 : -1}
      aria-selected={selected} className={`agx-jl-row${nested ? " is-sub" : ""}`}
      {...(drag ? { draggable: true, onDragStart: drag.onStart, onDragEnd: drag.onEnd, onDragOver: drag.onOver, onDrop: drag.onDrop, "data-edge": drag.edge ?? undefined } : {})}
      onClick={() => onOpen(t.id)}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onOpen(t.id); } }}
      onContextMenu={onMenu ? (e) => onMenu(e, t) : undefined}>
      <div className="agx-jl-gutter">
        {onPick && (
          <button type="button" className="agx-jl-cb" role="checkbox" aria-checked={!!picked}
            aria-label={`${picked ? "Remove" : "Add"} ${keyOf(t)} to the selection`}
            data-tip={tipAttr(picked ? "Remove from selection" : "Add to selection")} data-on={picked ? "" : undefined}
            onClick={(e) => { e.stopPropagation(); onPick(); }}>
            <CheckboxIcon size={ICON.sm} checked={!!picked} />
          </button>
        )}
        {open ? (
          <button type="button" className="agx-jl-twist" aria-expanded={open.expanded}
            aria-label={`${open.expanded ? "Hide" : "Show"} the ${open.count} ${open.count === 1 ? "sub-task" : "sub-tasks"} of ${keyOf(t)}`}
            data-tip={tipAttr({ name: open.expanded ? "Hide the sub-tasks" : "Show the sub-tasks", detail: keyOf(t) })}
            onClick={(e) => { e.stopPropagation(); open.onToggle(); }}>
            <CaretIcon size={ICON.xs} />
          </button>
        ) : <span aria-hidden />}
      </div>
      <div className="agx-jl-keycell">
        <div className="agx-jl-keyline">
          <span className="agx-jl-tile lg" style={{ ["--t" as string]: mark.tone }} data-tip={tipAttr(mark.name)}>{mark.letter}</span>
          <span className="k">{keyOf(t)}</span>
        </div>
        {prog && (
          <div className="agx-jl-mb" role="img" aria-label={`Workflow position ${prog.done} of ${prog.of}`} data-tip={tipAttr(`Status ${t.status}: step ${prog.done} of ${prog.of}`)}>
            {Array.from({ length: prog.of }, (_, i) => <i key={i} {...(i < prog.done ? { "data-on": done || i < prog.done - 1 ? "ok" : "mid" } : {})} />)}
            {t.flagged && <span style={{ color: "var(--warning)", display: "inline-flex", marginLeft: 4 }} data-tip={tipAttr("Flagged: an impediment is raised on this card")}><FlagIcon size={ICON.xs} /></span>}
          </div>
        )}
        {ring && <span className="agx-jl-ring" data-tip={tipAttr(`${ring.done} of ${ring.of} sub-tasks done`)}>{ring.done}/{ring.of}</span>}
      </div>
      <div className="agx-jl-main">
        <div className="agx-jl-title">
          {nested && <span className="agx-jl-elbow" aria-hidden><SubIcon /></span>}
          {dot && <span className="agx-jl-dot" style={{ ["--d" as string]: dot.color ?? "var(--text4)" }} data-tip={tipAttr(dot.name)} />}
          <span className="agx-jl-trunc" data-tip={tipAttr(t.title)}>{t.title}</span>
          <ChangedMark id={t.id} />
          {t.tags.slice(0, 2).map((g) => <span key={g} className="tg">#{g}</span>)}
          {blockedBy.length > 0 && <span className="agx-jl-tag blk" data-tip={tipAttr(`Waiting on ${blockerWords(blockedBy)!.tip}`)}>{blockedBy.length > 1 ? `blocked by ${blockedBy.length} cards` : `blocked by ${blockerWords(blockedBy)!.first}`}</span>}
          {chip && <StateChip status={t.status} color={t.statusColor || undefined} done={done} />}
        </div>
        {!nested && (
          <div className="agx-jl-meta">
            {sp.length > 0 && <span className="sp">{sp.join(" · ")}</span>}
            {subs > 0 && <span className="m" data-tip={tipAttr(`${subs} ${subs === 1 ? "sub-task" : "sub-tasks"}`)}><SubIcon />{subs}</span>}
            {!!t.comments && <span className="m" data-tip={tipAttr(`${t.comments} ${t.comments === 1 ? "comment" : "comments"}`)}><CommentIcon size={ICON.xs} />{t.comments}</span>}
            {cols.stacked && !cols.agent && <AgentCell card={t} />}
            {cols.stacked && !cols.pr && <span className="agx-jl-pr"><Pr card={t} /></span>}
          </div>
        )}
      </div>
      {cols.status && (
        <div className="agx-jl-cell">
          <button type="button" className="agx-jl-st" aria-haspopup="menu" aria-label={`Status ${t.status}. Change it`} data-tip={tipAttr({ name: t.status, hint: { text: "Move this card" } })}
            onClick={(e) => { e.stopPropagation(); (onStatus ?? onMenu)?.(e, t); }}>
            <span className="d" style={{ ["--d" as string]: t.statusColor ?? "var(--text4)" }} />{t.status}<span className="c">▾</span>
          </button>
        </div>
      )}
      {cols.agent && <div className="agx-jl-cell"><AgentCell card={t} quiet={nested} /></div>}
      {cols.pr && <div className="agx-jl-cell">{nested ? null : <PrCell card={t} />}</div>}
      {cols.who && <div className="agx-jl-cell"><PeopleFaces people={t.people ?? []} /></div>}
      {onForget && (
        <button type="button" className="agx-jl-ghost" aria-label="Forget this card" data-tip={tipAttr("Forget this card: it leaves the list, not Jira")}
          onClick={(e) => { e.stopPropagation(); onForget(); }}><CrossIcon size={ICON.xs} /></button>
      )}
    </div>
  );
}

export const JiraRow = memo(RowView);
