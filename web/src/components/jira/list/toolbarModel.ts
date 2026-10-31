/*
 * What the toolbar, the search row, the chips row and the footer decide, apart from the screen: there is no renderer in
 * this project, so each rule is a function a test can reach.
 */
import type { JiraBoardSprint, ListPlace, ListStatus, ProviderTask } from "../../../../../shared/providers.ts";
import { looksLikeCardId } from "../../../lib/boardGroups.ts";
import { fmtAgo } from "../../../lib/format.ts";
import { sprintLine } from "../../../lib/jiraBoardContext.ts";
import { GROUP_BY, type GroupBy, type ThenBy } from "../../../lib/jiraAreas.ts";
import { tipAttr, type TipSpec } from "../../../lib/tip.ts";
import type { JiraListCounts, JiraListFilters } from "./model.ts";

/** Space, project, board: the parts the breadcrumb draws, nothing empty. */
export const breadcrumbOf = (place: ListPlace | undefined): string[] =>
  [place?.space, place?.folder, place?.list].filter((p): p is string => !!p);

/** The sprint badge: its name, what is left, and the tooltip with the dates, the points and the goal. */
export function sprintChip(s: JiraBoardSprint, now: number, totals?: { todo: number; doing: number; done: number }): { name: string; left: string; late: boolean; tip: string } {
  const line = sprintLine(s, now);
  const spec: TipSpec = {
    name: s.name,
    ...(line.range ? { detail: line.range } : {}),
    ...(line.left ? { tag: line.left } : {}),
    text: [totals ? `${totals.todo} to do, ${totals.doing} in progress, ${totals.done} done points` : "", s.goal ?? ""].filter(Boolean).join(". ") || "The sprint this board is in.",
  };
  return { name: s.name, left: line.left, late: line.late, tip: tipAttr(spec) };
}

/** "read 2m ago". Nothing before the first read. */
export const readStamp = (at: number): string => (at ? `read ${fmtAgo(at) === "now" ? "just now" : `${fmtAgo(at)} ago`}` : "");

/** The footer's words: "14 of 19", "14 of 19+" when the read was cut short. */
export function footerCount(c: JiraListCounts, truncated: boolean): string {
  return `${c.shown} of ${c.total}${truncated ? "+" : ""}`;
}

export interface StatusRow { status: string; color: string | undefined; count: number; on: boolean }

/** The Status menu: working statuses first, the finished ones apart under "Done", each with how many cards wear it. */
export function statusMenuOf(statuses: readonly ListStatus[], cards: readonly ProviderTask[], picked: readonly string[]): { working: StatusRow[]; finished: StatusRow[] } {
  const row = (s: ListStatus): StatusRow => ({ status: s.status, color: s.color, count: cards.filter((t) => t.status === s.status).length, on: picked.includes(s.status) });
  const isDone = (s: ListStatus) => s.type === "done" || s.type === "closed";
  return { working: statuses.filter((s) => !isDone(s)).map(row), finished: statuses.filter(isDone).map(row) };
}

/** The menu stays open on a pick, so every pick is a toggle of one name. */
export const togglePick = (picked: readonly string[], name: string): string[] =>
  picked.includes(name) ? picked.filter((x) => x !== name) : [...picked, name];

export const statusTrigger = (picked: readonly string[]): string => (picked.length ? `${picked.length} selected` : "Status");

/** "search the site" shows once there is something to search for; a key is a jump, with its own row. */
export const siteSearchOffered = (q: string): boolean => q.trim().length >= 2 && !looksLikeCardId(q, true, true);

/** A typed key that no card on the page wears: offer to fetch it from the site. */
export function fetchOffered(q: string, cards: readonly ProviderTask[]): string | null {
  if (!looksLikeCardId(q, true, true)) return null;
  const want = q.trim().toLowerCase();
  const here = cards.some((t) => t.id.toLowerCase() === want || (t.customId ?? "").toLowerCase() === want || (t.customId ?? "").toLowerCase().endsWith(`-${want}`));
  return here ? null : q.trim();
}

/** Why a hit is in the sheet: the card itself, or a card that mentions what was typed. */
export function hitReason(t: ProviderTask, asked: string): "the card" | "mentions it" {
  const want = asked.trim().toLowerCase();
  const key = (t.customId ?? t.id).toLowerCase();
  return want && (key === want || key.endsWith(`-${want}`)) ? "the card" : "mentions it";
}

/** Group and Then, as the board offers them: Area only where the board has epics. */
export function groupChoices(hasAreas: boolean): { value: GroupBy; label: string }[] {
  return GROUP_BY.filter((g) => hasAreas || g.id !== "area").map((g) => ({ value: g.id, label: g.label }));
}
export function thenChoices(by: GroupBy, hasAreas: boolean): { value: ThenBy; label: string }[] {
  return by === "status"
    ? [{ value: "none", label: "Nothing" }, ...(hasAreas ? [{ value: "area" as const, label: "Area" }] : [])]
    : [{ value: "none", label: "Nothing" }, { value: "status", label: "Status" }];
}
/** Changing the first grouping resets the second: "Then" is a choice made against it. */
export const withGroup = (by: GroupBy): Pick<JiraListFilters, "group" | "thenGroup"> => ({ group: by, thenGroup: "none" });

/** The one avatar the Mine chip wears: yours, when any card on the page carries it. */
export function myFaceOf(cards: readonly ProviderTask[]): string {
  for (const t of cards) for (const p of t.people ?? []) if (p.me && p.avatar) return p.avatar;
  return "";
}

/** Show done reads as what pressing it does, not as a caption. */
export const showDoneLabel = (on: boolean, done: number): string => (on ? "Showing everything" : `Show ${done} done`);
