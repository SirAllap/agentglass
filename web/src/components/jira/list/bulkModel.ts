/*
 * The decisions behind the bulk sheet, with no renderer: which picked cards a change would really change, the sentence
 * that names the change, and how the server's per-card answers fold into what each row shows.
 */

export type BulkKind = "sprint" | "backlog" | "assignee" | "priority" | "parent" | "labels" | "flag";

/** What a picked card holds now, as the sheet shows it and as "already there" is decided. */
export interface BulkCard {
  key: string;
  title: string;
  sprintId?: string | null;
  sprint?: string | null;
  /** Account keys of the people on the card, when known. */
  assigneeKeys?: string[];
  assignee?: string;
  priorityId?: string | null;
  priority?: string | null;
  parentKey?: string | null;
  labels?: string[];
  flagged?: boolean;
}

export interface BulkAsk {
  kind: BulkKind;
  /** Sprint id, person key (null = nobody), priority id, parent key (null = none) or the flag (true/false). */
  value?: string | boolean | null;
  /** The name the sentence shows for `value`: "Orbit Sprint 12", "Sam Orbit", "High". */
  label?: string;
  add?: string[];
  remove?: string[];
}

export const BULK_MAX = 50;

/** True when the card already holds what the change would give it. A card of unknown state is never skipped. */
export function alreadyThere(card: BulkCard, ask: BulkAsk): boolean {
  switch (ask.kind) {
    case "sprint": return !!ask.value && card.sprintId === ask.value;
    case "backlog": return card.sprintId === null || (card.sprintId === undefined && card.sprint === null);
    case "assignee": return card.assigneeKeys !== undefined && (ask.value === null ? card.assigneeKeys.length === 0 : card.assigneeKeys.length === 1 && card.assigneeKeys[0] === ask.value);
    case "priority": return !!ask.value && card.priorityId === ask.value;
    case "parent": return card.parentKey !== undefined && (card.parentKey ?? null) === (ask.value ?? null);
    case "flag": return card.flagged !== undefined && card.flagged === (ask.value === true);
    case "labels": {
      if (!card.labels) return false;
      const have = new Set(card.labels);
      return (ask.add ?? []).every((l) => have.has(l)) && (ask.remove ?? []).every((l) => !have.has(l));
    }
  }
}

export interface BulkPlan { change: BulkCard[]; skip: BulkCard[]; tooMany: boolean }

export function planBulk(cards: readonly BulkCard[], ask: BulkAsk): BulkPlan {
  const change: BulkCard[] = [], skip: BulkCard[] = [];
  for (const c of cards) (alreadyThere(c, ask) ? skip : change).push(c);
  return { change, skip, tooMany: change.length > BULK_MAX };
}

const cards = (n: number) => (n === 1 ? "1 card" : `${n} cards`);

/** One sentence for the change: "Move 5 cards to INF Sprint 48". */
export function bulkSentence(n: number, ask: BulkAsk): string {
  const to = ask.label ?? "";
  switch (ask.kind) {
    case "sprint": return `Move ${cards(n)} to ${to}`;
    case "backlog": return `Move ${cards(n)} to the backlog`;
    case "assignee": return ask.value === null ? `Take the assignee off ${cards(n)}` : `Assign ${cards(n)} to ${to}`;
    case "priority": return `Set the priority of ${cards(n)} to ${to}`;
    case "parent": return ask.value === null ? `Take the parent off ${cards(n)}` : `Put ${cards(n)} under ${to || String(ask.value)}`;
    case "flag": return ask.value === true ? `Flag ${cards(n)}` : `Take the flag off ${cards(n)}`;
    case "labels": {
      const parts = [ask.add?.length ? `add ${ask.add.join(", ")}` : "", ask.remove?.length ? `remove ${ask.remove.join(", ")}` : ""].filter(Boolean);
      return `On ${cards(n)}: ${parts.join(" and ") || "no label change"}`;
    }
  }
}

/** What the sheet shows as a card's new value, next to the old. */
export function newValueOf(ask: BulkAsk): string {
  switch (ask.kind) {
    case "backlog": return "Backlog";
    case "flag": return ask.value === true ? "Flagged" : "Not flagged";
    case "labels": return [...(ask.add ?? []).map((l) => `+${l}`), ...(ask.remove ?? []).map((l) => `−${l}`)].join(" ");
    case "assignee": case "parent": return ask.value === null ? "None" : ask.label ?? String(ask.value);
    default: return ask.label ?? String(ask.value ?? "");
  }
}

export type RowState = { s: "idle" } | { s: "pending" } | { s: "done" } | { s: "failed"; error: string };
export interface BulkResultRow { key: string; ok: boolean; error?: string }

/** Fold the server's answer into row states. A card the answer does not name is failed, never done by silence. */
export function foldResults(keys: readonly string[], results: readonly BulkResultRow[] | undefined): Record<string, RowState> {
  const by = new Map((results ?? []).map((r) => [r.key.toUpperCase(), r]));
  const out: Record<string, RowState> = {};
  for (const k of keys) {
    const r = by.get(k.toUpperCase());
    out[k] = !r ? { s: "failed", error: "Jira did not say what happened to this card" } : r.ok ? { s: "done" } : { s: "failed", error: r.error ?? "Jira did not accept the change" };
  }
  return out;
}

/** The keys "Retry failed" sends again. */
export const failedKeys = (rows: Record<string, RowState>): string[] => Object.keys(rows).filter((k) => rows[k].s === "failed");

/** The line under the rows once a run ends. */
export function runLine(rows: Record<string, RowState>): string {
  const all = Object.values(rows), bad = all.filter((r) => r.s === "failed").length, good = all.filter((r) => r.s === "done").length;
  if (!bad) return `Changed ${cards(good)}`;
  return good ? `Changed ${good} of ${all.length}; ${bad} failed` : `Nothing changed: ${bad} failed`;
}
