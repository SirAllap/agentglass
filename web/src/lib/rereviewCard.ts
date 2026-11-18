/*
 * What "Re-request review" puts back on the linked Jira card: who it was
 * assigned to and which status it was in when review was last asked, if the
 * author's follow-up work since has changed either. Pure: the changelog's raw
 * assignee/status edits (CardEvent.edit, oldest first), the time review was
 * last requested, and what the card is now.
 *
 * Ceiling: the changelog is read from its first page only (100 edits), so a
 * card with a longer history may answer "nothing to restore" rather than wrong.
 */
import type { CardEvent } from "../../../shared/providers.ts";

export interface CardNow { assignee: string; status: string }
export interface Restore { assignee?: { key: string; name: string }; status?: string }

/** Value of `field` at `at`: the `to` of the last edit at or before it, else the `from` of the first one after it. */
function at(events: CardEvent[], field: "assignee" | "status", when: number): { id: string; name: string } | null {
  const mine = events.filter((e) => e.edit?.field === field).sort((a, b) => a.at - b.at);
  if (!mine.length) return null;
  const before = mine.filter((e) => e.at <= when);
  const e = before.length ? before[before.length - 1]!.edit! : mine[0]!.edit!;
  return before.length ? { id: e.to, name: e.toString } : { id: e.from, name: e.fromString };
}

export function restoreAtReview(events: CardEvent[], reviewAt: number, now: CardNow): Restore {
  const out: Restore = {};
  const who = at(events, "assignee", reviewAt);
  if (who && who.id && who.name !== now.assignee) out.assignee = { key: who.id, name: who.name };
  const st = at(events, "status", reviewAt);
  if (st && st.name && st.name !== now.status) out.status = st.name;
  return out;
}

/** The line the button shows before it runs. */
export function rereviewLine(logins: string[], card: string | null, r: Restore | null, why?: string): string {
  const parts = [`Ask ${logins.join(", ")} again`];
  if (card && r) {
    if (r.assignee) parts.push(`assign ${card} to ${r.assignee.name}`);
    if (r.status) parts.push(`move it to ${r.status}`);
  } else if (why) parts.push(why);
  return parts.join(" · ");
}
