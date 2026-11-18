/*
 * The board card's right-click menu, decided apart from the screen: a filter box, a line with the key and a cut
 * title, then groups of actions (Open, Work, Edit, Links), some of which open a submenu (Move to, Assign, Sprint,
 * Send to terminal, Copy). menus/JiraCardMenu.tsx draws it; the host (JiraMenuHost.tsx) says what each id does.
 *
 * Every row here has an action behind it (the host decides how). The writes (Edit in panel, Create subtask, Clone,
 * Sprint, Epic, Move, Assign) are off with the "Changes to Jira are off" reason when the app may not change Jira.
 * Ceiling: one submenu deep, and the filter looks one level into the submenus ("Assign › Ana L."). The Epic
 * submenu lists at most EPIC_MAX epics: the sidebar and the Filters menu are where a long list is searched.
 */
import type { ProviderTask } from "../../../../../../shared/providers.ts";
import { branchName } from "../../../../lib/cardBranch.ts";
import { canHaveSubtasks } from "../../../../lib/jiraJoins.ts";
import { menuHead, stepsLine, WRITES_OFF_WHY, type MoveFacts } from "./menuModel.ts";

export interface Act {
  id: string;
  label: string;
  /** The cap on the right: only keys that really press the row while the menu is open. */
  key?: string;
  /** The grey second line. */
  sub?: string;
  /** Present means off, and this is the reason. */
  why?: string;
  /** A check mark: the current value. */
  chk?: boolean;
  /** Present means the row opens a submenu instead of acting. */
  children?: Act[];
  /** The step asks for fields: the card pane takes it, not a direct write. */
  asks?: boolean;
}
export interface ActGroup { label: string; items: Act[] }
export interface CardActions { head: string; groups: ActGroup[] }

export interface CardActionFacts {
  pr: number | null;
  pinned: boolean;
  writable: boolean;
  moves: MoveFacts;
  /** The board's active sprint; undefined where the view has no sprint to move to (the Sprint row is not drawn). */
  sprint?: { name: string } | null | undefined;
  /** Whether the card is already in that active sprint. */
  inSprint?: boolean;
  /** Every future sprint of the card's board, in the board's order; empty where it plans none. Only read when `sprint` is given. */
  futures?: readonly { id: string; name: string; start?: number; end?: number }[];
  /** The id of the sprint the card is in now (any state): the future one with it gets the tick. */
  sprintId?: string | null;
  /** The card is in no sprint: Backlog is the one that is checked. */
  inBacklog?: boolean;
  /** The space's epics, for the Epic submenu; undefined where the view does not know them (the row is not drawn). */
  epics?: readonly { key: string; name: string }[];
  /** The people the card can be given to: the ones on this board, me first. */
  people: readonly { key: string; name: string; me?: boolean; on?: boolean }[];
  agent: boolean;
}

export const EPIC_MAX = 30;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (ms: number): string => { const d = new Date(ms); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
/** A future sprint's dates for its row ("Nov 18 – Dec 2"); empty when the board has not dated it. */
export const sprintDates = (x: { start?: number; end?: number }): string =>
  x.start && x.end ? `${day(x.start)} – ${day(x.end)}` : x.start ? `from ${day(x.start)}` : "";
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const keyOf = (t: ProviderTask): string => t.customId ?? t.id;
const act = (id: string, label: string, o: Partial<Act> = {}): Act => ({ id, label, ...o });

export function moveChildren(t: ProviderTask, f: Pick<CardActionFacts, "writable" | "moves">): Act[] {
  const m = f.moves;
  if (!f.writable) return [act("why", WRITES_OFF_WHY, { why: WRITES_OFF_WHY })];
  if (m === "reading") return [act("why", "Reading the steps…", { why: "Reading the steps…" })];
  if ("error" in m) return [act("why", m.error || "Could not read the steps", { why: m.error || "Could not read the steps" })];
  if (!m.to.length) return [act("why", `No step from ${t.status}`, { why: `No step from ${t.status}` })];
  return m.to.slice(0, 12).map((s, i) => act(`move:${s.key ?? i}`, s.status, s.asks ? { asks: true, sub: "Asks for details" } : {}));
}

export function assignChildren(f: Pick<CardActionFacts, "writable" | "people">, onCard: boolean): Act[] {
  if (!f.writable) return [act("why", WRITES_OFF_WHY, { why: WRITES_OFF_WHY })];
  return [
    ...f.people.map((p) => act(`assign:${p.key}`, p.me ? `You (${p.name})` : p.name, p.on ? { chk: true } : {})),
    act("assign:", "Unassigned", onCard ? {} : { chk: true }),
  ];
}

/** The Epic submenu: each epic of the space, then "No epic"; the card's own is checked. */
export function epicChildren(t: ProviderTask, f: Pick<CardActionFacts, "writable" | "epics">): Act[] {
  if (!f.writable) return [act("why", WRITES_OFF_WHY, { why: WRITES_OFF_WHY })];
  const mine = t.parent?.type === "Epic" ? t.parent.key : null;
  const list = (f.epics ?? []).slice(0, EPIC_MAX);
  return [
    ...list.map((e) => act(`epic:${e.key}`, e.name, { sub: e.key, ...(e.key === mine ? { chk: true } : {}) })),
    act("epic:", "No epic", mine ? {} : { chk: true }),
  ];
}

export function cardActions(t: ProviderTask, f: CardActionFacts): CardActions {
  const key = keyOf(t);
  const off = f.writable ? undefined : WRITES_OFF_WHY;
  const m = f.moves;
  const moveSub = m !== "reading" && "to" in m && m.to.length ? stepsLine(m.to) : undefined;
  const groups: ActGroup[] = [
    { label: "Open", items: [
      act("open", "Open card", { key: "Enter" }),
      act("edit", "Edit in panel", off ? { why: off } : {}),
      t.url ? act("openJira", "Open in Jira ↗") : act("openJira", "Open in Jira ↗", { why: "It has no address" }),
    ] },
    { label: "Work", items: [
      act("terminal", "Send to terminal", { children: [
        act("worker", "New worker", f.agent ? { why: "A worker is already running" } : t.statusKind === "done" ? { why: "Card is already Done" } : { sub: "Opens the card and starts work there" }),
        act("copyPrompt", "Copy prompt for the card", { sub: "To the clipboard, no terminal" }),
      ] }),
      act("next", "Start work", f.agent ? { why: "A worker is already running" } : t.statusKind === "done" ? { why: "Card is already Done" } : {}),
      act("flight", "Start a flight plan"),
      act("subtask", "Create subtask", off ? { why: off } : !canHaveSubtasks(t.issueType) ? { why: "A sub-task cannot have sub-tasks" } : {}),
      act("clone", "Clone", off ? { why: off } : { sub: "A copy in Jira, CLONE - title" }),
    ] },
    { label: "Edit", items: [
      act("moveTo", "Move to", { children: moveChildren(t, f), ...(off ? { why: off } : moveSub ? { sub: moveSub } : {}) }),
      act("assignTo", "Assign", { children: assignChildren(f, t.assignees.length > 0), ...(off ? { why: off } : {}) }),
      ...(f.sprint === undefined ? [] : [act("sprintTo", "Sprint", {
        ...(off ? { why: off } : {}),
        children: [
          act("sprint:current", f.sprint ? `Current ${f.sprint.name}` : "Current", f.sprint ? (f.inSprint ? { chk: true } : {}) : { why: "No active sprint on this board" }),
          ...(f.futures?.length
            ? f.futures.map((x) => act(`sprint:to:${x.id}`, x.name, { ...(sprintDates(x) ? { sub: sprintDates(x) } : {}), ...(f.sprintId === x.id ? { chk: true } : {}) }))
            : [act("sprint:next", "Next", { why: "No next sprint is planned" })]),
          act("sprint:backlog", "Backlog", f.inBacklog ? { chk: true } : {}),
        ],
      })]),
      ...(f.epics === undefined ? [] : [act("epicTo", "Epic", {
        children: epicChildren(t, f),
        ...(off ? { why: off } : /^epic$/i.test(t.issueType ?? "") ? { why: "An epic is not in an epic" } : !canHaveSubtasks(t.issueType) ? { why: "A sub-task follows its parent's epic" } : !f.epics.length ? { why: "This space has no epics" } : {}),
      })]),
    ] },
    { label: "Links", items: [
      act("copyMenu", "Copy", { children: [
        act("copyKey", "Key", { sub: key }),
        t.url ? act("copyLink", "Link") : act("copyLink", "Link", { why: "It has no address" }),
        act("copyBranch", "Branch name", { sub: cut(branchName(key, t.title), 26) }),
      ] }),
      f.pr !== null ? act("pr", `Open pull request #${f.pr}`) : act("pr", "Open pull request", { why: "No pull request linked yet" }),
      act("pin", f.pinned ? "Unpin from the top" : "Pin to top of lane"),
      act("reread", "Read this card again"),
      act("hide", "Hide from this list", { sub: "Only here, not in Jira" }),
    ] },
  ];
  return { head: menuHead(key, t.title), groups };
}

/**
 * What the filter box leaves: every row whose label has the text, and the children of a submenu whose own label
 * or the child's has it, as "Assign › Ana L.". No text, no flattening: the groups as they are.
 */
export function filterActions(groups: readonly ActGroup[], q: string): Act[] {
  const s = q.trim().toLowerCase();
  const out: Act[] = [];
  for (const g of groups) for (const a of g.items) {
    if (!s) { out.push(a); continue; }
    if (!a.children) { if (a.label.toLowerCase().includes(s)) out.push(a); continue; }
    if (a.label.toLowerCase().includes(s)) out.push(a);
    for (const c of a.children) if (!c.children && c.id !== "why" && c.label.toLowerCase().includes(s)) out.push({ ...c, label: `${a.label} › ${c.label}`, ...(a.why && !c.why ? { why: a.why } : {}) });
  }
  return out;
}

/** The index the arrows land on from `from` going `dir`, skipping rows that are off; `from` itself when none is on. */
export function nextOn(rows: readonly Pick<Act, "why">[], from: number, dir: 1 | -1): number {
  const n = rows.length;
  for (let i = 1; i <= n; i++) {
    const j = (((from + dir * i) % n) + n) % n;
    if (!rows[j]!.why) return j;
  }
  return from;
}

/** The Assign popover a card's face opens: you first, the teammates after, Unassigned last, each numbered 1..9 for the key that picks it. */
export function assignPop(f: Pick<CardActionFacts, "writable" | "people">, onCard: boolean): (Act & { key?: string })[] {
  const kids = assignChildren(f, onCard);
  return kids.map((k, i) => (k.why || i > 8 ? k : { ...k, key: String(i + 1) }));
}
