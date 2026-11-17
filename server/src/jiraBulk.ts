/*
 * One change to several Jira cards, written card by card in the answer: `{ ok, results: [{ key, ok, error? }] }`.
 * Sprint and backlog go as one Agile call for the whole set, as the single-card routes do; if that call fails, each
 * card is tried alone so the error is per card. A field change reuses `editCard` (jiraEdit.ts) or `setAssignee`
 * (jira.ts), at most four cards at once. The route is person-only (`bulkRefusal`): a worker is refused before any call.
 */
import { ISSUE_KEY, apiOf, epoch, isObj, jiraCall, priorities, setAssignee, writeRefusal, type JiraCreds, type JiraWriteKind } from "./jira.ts";
import { editCard, type EditAsk } from "./jiraEdit.ts";
import { moveToBacklog, moveToSprint } from "./jiraSprintMove.ts";
import { activeSprint, futureSprints } from "./jiraBoardContext.ts";
import type { WriteOutcome } from "./trackerTypes.ts";

export const BULK_MAX = 50;
/** Cards written at once; Jira throttles harder than that. */
export const BULK_PARALLEL = 4;
export const BULK_KINDS = ["sprint", "backlog", "assignee", "priority", "parent", "labels", "flag"] as const;
export type BulkKind = (typeof BULK_KINDS)[number];
export interface BulkChange { kind: BulkKind; value?: unknown; add?: unknown; remove?: unknown }
export interface BulkResult { key: string; ok: boolean; error?: string }
export interface BulkAnswer { ok: boolean; results: BulkResult[]; error?: string }

export const BULK_PERSON_ONLY = "Only the person makes a bulk Jira change; an agent cannot.";

/** Which write switch a change sits behind: giving a card to somebody is "assign", the rest is "move". */
export const kindOf = (change: BulkChange): JiraWriteKind => (change.kind === "assignee" ? "assign" : "move");

/** The sentence that stops a bulk call before any Jira request, or null. `status` is the HTTP code that goes with it. */
export function bulkRefusal(person: boolean, keys: unknown, change: unknown): { status: number; error: string } | null {
  if (!person) return { status: 403, error: BULK_PERSON_ONLY };
  if (!isObj(change) || !(BULK_KINDS as readonly string[]).includes(String(change.kind))) return { status: 400, error: "That is not a change a set of cards can take" };
  const off = writeRefusal(kindOf(change as unknown as BulkChange));
  if (off) return { status: 400, error: off };
  if (!Array.isArray(keys) || !keys.length) return { status: 400, error: "Pick at least one card" };
  if (keys.length > BULK_MAX) return { status: 400, error: `Change at most ${BULK_MAX} cards at once` };
  if (!keys.every((k) => typeof k === "string" && ISSUE_KEY.test(k.trim()))) return { status: 400, error: "That is not a Jira card id" };
  return null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);

/** The one-card writes a change is made of; the Jira ones are the default, a test hands in its own. */
export interface BulkDeps {
  sprint(id: string, keys: string[]): Promise<WriteOutcome>;
  backlog(keys: string[]): Promise<WriteOutcome>;
  /** One field of one card. */
  edit(key: string, ask: EditAsk): Promise<WriteOutcome>;
  assign(key: string, to: string | null): Promise<WriteOutcome>;
}

async function updatedOf(creds: JiraCreds, key: string): Promise<number> {
  const r = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(key)}?fields=updated`, { fresh: true });
  return r.ok && isObj(r.data) && isObj(r.data.fields) ? epoch(r.data.fields.updated) : 0;
}

export function jiraDeps(creds: JiraCreds): BulkDeps {
  return {
    sprint: (id, keys) => moveToSprint(creds, id, keys),
    backlog: (keys) => moveToBacklog(creds, keys),
    edit: async (key, ask) => editCard(creds, key, ask, await updatedOf(creds, key)),
    assign: async (key, to) => setAssignee(creds, key, to, await updatedOf(creds, key)),
  };
}

/** Run `fn` over `items`, at most `limit` at a time, answers in the order of the items. */
export async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const fold = (key: string, r: WriteOutcome): BulkResult => (r.ok ? { key, ok: true } : { key, ok: false, error: r.error ?? "Jira did not accept the change" });

/** Several writes on one card, stopping at the first that fails. */
async function inOrder(asks: Array<() => Promise<WriteOutcome>>): Promise<WriteOutcome> {
  for (const go of asks) { const r = await go(); if (!r.ok) return r; }
  return { ok: true };
}

export async function runBulk(deps: BulkDeps, keysIn: string[], change: BulkChange): Promise<BulkAnswer> {
  const keys = [...new Set(keysIn.map((k) => k.trim().toUpperCase()))];
  let results: BulkResult[];
  if (change.kind === "sprint" || change.kind === "backlog") {
    const whole = change.kind === "sprint" ? await deps.sprint(String(change.value ?? ""), keys) : await deps.backlog(keys);
    if (whole.ok) results = keys.map((key) => ({ key, ok: true }));
    else if (keys.length === 1) results = [fold(keys[0], whole)];
    else {
      // The whole set was refused: one card at a time, so each says why for itself.
      results = await pool(keys, BULK_PARALLEL, async (key) => fold(key, change.kind === "sprint" ? await deps.sprint(String(change.value ?? ""), [key]) : await deps.backlog([key])));
    }
  } else {
    const asksFor = (key: string): Array<() => Promise<WriteOutcome>> => {
      switch (change.kind) {
        case "assignee": return [() => deps.assign(key, typeof change.value === "string" ? change.value : null)];
        case "priority": return [() => deps.edit(key, { field: "priority", value: change.value })];
        case "parent": return [() => deps.edit(key, { field: "parent", value: change.value ?? null })];
        case "flag": return [() => deps.edit(key, { field: "flag", value: change.value === true })];
        default: return [
          ...strings(change.add).map((l) => () => deps.edit(key, { field: "labels", add: l })),
          ...strings(change.remove).map((l) => () => deps.edit(key, { field: "labels", remove: l })),
        ];
      }
    };
    results = await pool(keys, BULK_PARALLEL, async (key) => {
      const asks = asksFor(key);
      if (!asks.length) return { key, ok: false, error: "Name a label to add or take off" };
      return fold(key, await inOrder(asks));
    });
  }
  return { ok: results.every((r) => r.ok), results };
}

/** What a bulk change offers: the active sprint, then the future ones in the board order (`next` is the first future one), and the site priorities. */
export async function bulkSprints(creds: JiraCreds, board: string): Promise<{ ok: boolean; error?: string; active: { id: string; name: string } | null; future: Array<{ id: string; name: string }>; next: string; priorities: Array<{ id: string; name: string }> }> {
  const [a, f, p] = await Promise.all([activeSprint(creds, board), futureSprints(creds, board), priorities(creds)]);
  if (!a.ok && !f.ok) return { ok: false, error: a.error ?? f.error ?? "Jira did not answer", active: null, future: [], next: "", priorities: [] };
  const future = (f.data ?? []).map((s) => ({ id: s.id, name: s.name }));
  const prio = p.ok && p.data ? p.data.ids.map((id, i) => ({ id, name: p.data!.names[i] ?? id })) : [];
  return { ok: true, active: a.data ? { id: a.data.id, name: a.data.name } : null, future, next: future[0]?.id ?? "", priorities: prio };
}
