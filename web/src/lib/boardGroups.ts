/*
 * The board's status groups: one per status the view has, empty ones included,
 * in the tracker's own order.
 *
 * Lifted out of the Tasks body so the rule can be asserted without a renderer,
 * and so every tracker's board is grouped by the same code. The order, the
 * colour and "done" all come from the `statuses` the view reports, never from a
 * list of ours. How the cards inside a group are ordered is the caller's.
 */
import type { ListStatus, ProviderTask } from "../../../shared/providers.ts";

export interface StatusGroup {
  status: string;
  rows: ProviderTask[];
  color: string | undefined;
  done: boolean;
  points: number;
  i: number;
}

export function groupByStatus(
  rows: readonly ProviderTask[], statuses: readonly ListStatus[],
  /** How the cards inside one group are ordered: the tracker's own hand, which is the body's to say. */
  within: (list: ProviderTask[]) => ProviderTask[] = (list) => list,
): StatusGroup[] {
  /* A status is the same status whatever its case: two projects of one site may spell it "In review" and "In Review", and the view's
     own list (which merges them) has one entry. The group wears the listed spelling. */
  const lower = (name: string) => name.toLowerCase();
  const order = new Map(statuses.map((s, i) => [lower(s.status), { i, color: s.color, type: s.type, name: s.status }]));
  const by = new Map<string, { name: string; list: ProviderTask[] }>();
  for (const t of rows) {
    const name = t.status || "—";
    const k = lower(name);
    const g = by.get(k) ?? by.set(k, { name: order.get(k)?.name ?? name, list: [] }).get(k)!;
    g.list.push(t);
  }
  /*
   * EVERY STATUS THE LIST HAS, not only the ones that happen to hold a card.
   *
   * A board drew a group per status it SAW in the rows, so a workflow step
   * with nothing in it right now simply was not there — and a person reading
   * the board cannot tell "no cards in TO DO" from "this list has no TO DO".
   * ClickUp's own page draws all fifteen, empty ones included, because the
   * empty ones are half of what a workflow tells you: a status with no cards
   * must still show as a group.
   *
   * Seeded before the rows are folded in, so the order is the workflow's own
   * and an empty group lands exactly where it belongs between two full ones.
   */
  for (const s of statuses) if (!by.has(lower(s.status))) by.set(lower(s.status), { name: s.status, list: [] });

  return [...by.entries()]
    .map(([k, { name, list }]) => ({
      status: name,
      rows: within(list),
      color: order.get(k)?.color ?? list[0]?.statusColor,
      done: (order.get(k)?.type ?? "") === "done" || (order.get(k)?.type ?? "") === "closed",
      points: list.reduce((n, t) => n + (t.points ?? 0), 0),
      i: order.get(k)?.i ?? 999,
    }))
    .sort((a, b) => a.i - b.i);
}

/**
 * Which optional columns the table draws. A column with no value on any card is
 * left out, so a site without sprints or estimates shows a narrower table and
 * never an empty one. Points and comment counts are the exception where the
 * tracker always supplies them (`alwaysDrawn`): there an empty cell is an
 * answer ("not estimated yet", "no comments") and worth its width.
 */
export function tableColumns(tasks: readonly ProviderTask[], alwaysDrawn: boolean): { who: boolean; sprint: boolean; est: boolean; pts: boolean; cmts: boolean } {
  return {
    who: tasks.some((t) => t.assignees.length > 0),
    sprint: tasks.some((t) => !!t.sprint),
    est: tasks.some((t) => !!t.estimateHours),
    pts: alwaysDrawn || tasks.some((t) => t.points != null),
    cmts: alwaysDrawn || tasks.some((t) => t.comments != null),
  };
}

/**
 * The unfinished cards this one is waiting on, found among the cards in hand.
 * A dependency that is done does not block, and one that is not on this board
 * cannot be told apart from one that is finished, so it does not block either.
 */
export function blockersOf(t: ProviderTask, byId: ReadonlyMap<string, ProviderTask>): ProviderTask[] {
  return (t.waitsOn ?? []).map((id) => byId.get(id)).filter((x): x is ProviderTask => !!x && x.statusKind !== "done");
}

/** Open cards nothing unfinished is in the way of: what the "ready" chip counts. */
export function readyCount(tasks: readonly ProviderTask[]): number {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.filter((t) => t.statusKind !== "done" && !blockersOf(t, byId).length).length;
}

/**
 * A card a pane read or wrote, folded over the row the board holds for it.
 * The board's read carries fields the card's own read does not (a sprint, points,
 * what it waits on, its rank), so the newer copy is laid over the older one and
 * never replaces it: opening a card must not empty its row.
 */
export function foldCard(row: ProviderTask | undefined, fresh: ProviderTask): ProviderTask {
  return row ? { ...row, ...fresh } : fresh;
}

/**
 * Is what was typed a card id to jump to? A bare number or a prefixed one with
 * three digits or more, loose on purpose (the server decides what is a card).
 * A source with no workspace search has only the jump, so its keys may be short:
 * ORBIT-12 is a card there, while on a board that can search, "ORBIT-12" is a
 * query like any other. A source whose keys are short and that can search too
 * (`shortKeys`, Jira: ORBIT-12 is a card) is asked for the card AND searched.
 */
export function looksLikeCardId(q: string, workspaceSearch: boolean, shortKeys = false): boolean {
  return /^\s*([A-Za-z][\w]*-)?\d{3,}\s*$/.test(q) || ((!workspaceSearch || shortKeys) && /^\s*[A-Za-z][A-Za-z0-9_]*-\d+\s*$/.test(q));
}
