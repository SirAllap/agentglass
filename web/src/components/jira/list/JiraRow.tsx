/*
 * One card of the list: a soft row, 52 high at least, two lines. Line one is the title, line two the key and what the card
 * carries (blocked, labels, sub-tasks, comments). The columns after it are the Sprint-or-Epic, the pull request, who is on it,
 * the due date and the points; which of them exist is `cols`, decided by the width. The row has no status chip: the lane says
 * it, and a lane that does not (a grouping other than status) gives each row a quiet dot instead.
 *
 * The pull request chip reads the project's one `/jira/prs` search through cardPrStore (a cache shared with the menus and the
 * dock), so forty rows are one request.
 */
import { memo, useState, useSyncExternalStore, type DragEvent, type MouseEvent } from "react";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import { avatarSrc } from "../../../lib/avatarSrc.ts";
import { cardPrInk, cardPrTint, pickCardPr, sortedCardPrs, type CardPr } from "../../../lib/cardPrPick.ts";
import { cardPrsOf, cardPrVersion, onCardPrs } from "../../../lib/cardPrStore.ts";
import { chipInk } from "../../../lib/contrast.ts";
import { BlockedIcon, CommentIcon, CrossIcon, FlagIcon, PullRequestIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { openPr, openPrs, prRefFromUrl } from "../../../lib/openPrs.ts";
import { dueWords } from "../../../lib/taskGrammar.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { ContextMenu, MenuItem } from "../../ContextMenu.tsx";
import { isSubtask, keyOf, type Cols } from "./laneModel.ts";

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

function Face({ p }: { p: NonNullable<ProviderTask["people"]>[number] }) {
  const [broken, setBroken] = useState(false);
  const tip = p.me ? `${p.name} (you)` : p.name;
  return (
    <span className="agx-jl-face" data-me={p.me ? "" : undefined} data-tip={tipAttr(tip)}
      style={p.color && !(p.avatar && !broken) ? { background: p.color, color: chipInk(p.color) } : undefined}>
      {p.avatar && !broken
        ? <img src={avatarSrc(p.avatar)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        : p.initials}
    </span>
  );
}

const SHOWN_FACES = 3;
function Who({ people }: { people: NonNullable<ProviderTask["people"]> }) {
  if (!people.length) return null;
  const rest = people.length - SHOWN_FACES;
  return (
    <span className="agx-jl-stack">
      {people.slice(0, SHOWN_FACES).map((p, i) => <Face key={p.key ?? p.id ?? `${p.name}${i}`} p={p} />)}
      {rest > 0 && <span className="more" data-tip={tipAttr(people.slice(SHOWN_FACES).map((p) => p.name).join(", "))}>+{rest}</span>}
    </span>
  );
}

const prWord = (p: CardPr): string => (p.draft ? "Draft" : p.state === "MERGED" ? "Merged" : p.state === "CLOSED" ? "Closed" : "Open");
function openPull(p: CardPr): void {
  const ref = prRefFromUrl(p.url);
  if (ref) openPr(ref.repo, p.number);
  else openPrs(String(p.number), p.state === "OPEN" ? "open" : "all");
}

/** The pull request of a card: one chip, "+n" when there are more, and a menu to pick one of them. */
function Pr({ card }: { card: ProviderTask }) {
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

export interface DragRow {
  edge: "top" | "bottom" | null;
  onStart: () => void; onEnd: () => void;
  onOver: (e: DragEvent<HTMLElement>) => void; onDrop: (e: DragEvent<HTMLElement>) => void;
}

export interface JiraRowProps {
  card: ProviderTask;
  cols: Cols;
  /** The third column's content: the sprint, or the epic of the card (name and tone). */
  third: { text: string; tone?: string | undefined } | null;
  today: string;
  selected: boolean;
  /** The one row a Tab reaches; the arrow keys move between the others. */
  tabbable: boolean;
  /** A sub-task drawn under its parent. */
  nested?: boolean;
  /** The lane does not say the status: a quiet dot does. */
  dot?: { color: string | undefined; name: string } | null;
  /** Keys of the unfinished cards this one waits on. */
  blockedBy: readonly string[];
  drag?: DragRow | undefined;
  onOpen: (id: string) => void;
  onMenu?: ((e: MouseEvent, card: ProviderTask) => void) | undefined;
  /** A looked-up card is kept off the board for this visit only; the row offers to forget it. */
  onForget?: (() => void) | undefined;
}

function RowView({ card: t, cols, third, today, selected, tabbable, nested, dot, blockedBy, drag, onOpen, onMenu, onForget }: JiraRowProps) {
  const mark = typeMark(t);
  const done = t.statusKind === "done";
  const due = t.due ? dueWords(t.due, today, done) : null;
  const subs = t.subtasks ?? 0;
  return (
    <div role="row" data-jl-row={t.id} data-done={done ? "" : undefined} tabIndex={tabbable ? 0 : -1}
      aria-selected={selected} className={`agx-jl-row${nested ? " is-sub" : ""}`}
      {...(drag ? { draggable: true, onDragStart: drag.onStart, onDragEnd: drag.onEnd, onDragOver: drag.onOver, onDrop: drag.onDrop, "data-edge": drag.edge ?? undefined } : {})}
      onClick={() => onOpen(t.id)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(t.id); } }}
      onContextMenu={onMenu ? (e) => onMenu(e, t) : undefined}>
      <span className="agx-jl-tile lg" style={{ ["--t" as string]: mark.tone }} data-tip={tipAttr(mark.name)}>{mark.letter}</span>
      <div className="agx-jl-main">
        <div className="agx-jl-title">
          {nested && <span className="agx-jl-elbow" aria-hidden><SubIcon /></span>}
          {dot && <span className="agx-jl-dot" style={{ ["--d" as string]: dot.color ?? "var(--text4)" }} data-tip={tipAttr(dot.name)} />}
          <span className="agx-jl-trunc" data-tip={tipAttr(t.title)}>{t.title}</span>
          {t.flagged && <span style={{ color: "var(--warning-ink)", display: "inline-flex" }} data-tip={tipAttr("Flagged: an impediment is raised on this card")}><FlagIcon size={ICON.xs} /></span>}
        </div>
        <div className="agx-jl-meta">
          <span className="k">{keyOf(t)}</span>
          {blockedBy.length > 0 && <span className="blk" data-tip={tipAttr(`Waiting on ${blockedBy.join(", ")}`)}><BlockedIcon size={ICON.xs} /> Blocked</span>}
          {t.tags.slice(0, 2).map((g) => <span key={g} className="tg">#{g}</span>)}
          {subs > 0 && <span className="m" data-tip={tipAttr(`${subs} ${subs === 1 ? "sub-task" : "sub-tasks"}`)}><SubIcon />{subs}</span>}
          {!!t.comments && <span className="m" data-tip={tipAttr(`${t.comments} ${t.comments === 1 ? "comment" : "comments"}`)}><CommentIcon size={ICON.xs} />{t.comments}</span>}
        </div>
      </div>
      {cols.epic && (
        <div className={`agx-jl-cell${third?.tone ? " epic" : ""}`}>
          {third?.tone && <span className="agx-jl-dot" style={{ ["--d" as string]: third.tone }} />}
          {third && <span className="agx-jl-trunc" data-tip={tipAttr(third.text)}>{third.text}</span>}
        </div>
      )}
      {cols.pr && <div className="agx-jl-cell"><Pr card={t} /></div>}
      {cols.who && <div className="agx-jl-cell"><Who people={t.people ?? []} /></div>}
      {cols.due && (
        <div className="agx-jl-cell due" data-tone={due?.tone}>
          {due && due.tone !== "none" && due.tone !== "done" && (<>{due.tone === "late" && <FlagIcon size={ICON.xs} />}{due.text}</>)}
        </div>
      )}
      {cols.pts && <div className="agx-jl-cell pts">{t.points ?? ""}</div>}
      {onForget && (
        <button type="button" className="agx-jl-ghost" aria-label="Forget this card" data-tip={tipAttr("Forget this card: it leaves the list, not Jira")}
          onClick={(e) => { e.stopPropagation(); onForget(); }}><CrossIcon size={ICON.xs} /></button>
      )}
    </div>
  );
}

export const JiraRow = memo(RowView);
