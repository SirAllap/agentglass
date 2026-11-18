/*
 * Which sprints a bulk move may offer, decided with no renderer. Each picked card gets the sprints of its own board:
 * the board the view shows first; else the boards of the card's project that have sprints (the one that holds the
 * card's sprint when there is one). The sprints a card may go to are the union over its boards; a set of cards may go
 * to the sprints valid for all of them. Every read is time-boxed, so the menu ends in a list or an error, never a spinner.
 */
import type { JiraBoardContext, ProviderTask } from "../../../../../shared/providers.ts";
import { sprintChoices, type SprintChoice } from "./bulkPickers.ts";

export const READ_MS = 8000;
export const BOARDS_MAX = 4;

export interface ScopeReads {
  projectBoards: (key: string) => Promise<{ ok: boolean; boards?: readonly { id: string; name: string }[] }>;
  boardContext: (viewId: string) => Promise<JiraBoardContext>;
}
export type ScopeCard = Pick<ProviderTask, "customId" | "id" | "sprintId" | "sprintState">;
export type Scope = { ok: true; choices: SprintChoice[]; boards: number; note: string | null } | { ok: false; error: string };

/** The card's sprints and the boards they came from. */
export interface CardSet { boardIds: string[]; sprints: SprintChoice[] }

/** Sprints valid for every card; the note when the cards sit on more than one distinct board set. */
export function sharedSprints(sets: readonly CardSet[]): { choices: SprintChoice[]; boards: number; note: string | null } {
  if (!sets.length) return { choices: [], boards: 0, note: null };
  const boards = new Set(sets.map((s) => [...s.boardIds].sort().join(",")));
  const ids = sets.map((s) => new Set(s.sprints.map((x) => x.id)));
  const choices = sets[0]!.sprints.filter((x) => ids.every((set) => set.has(x.id)));
  return { choices, boards: boards.size, note: boards.size > 1 ? `Cards from ${boards.size} boards: only shared sprints shown` : null };
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((ok, no) => {
    const t = setTimeout(() => no(new Error("Jira took too long to answer")), ms);
    p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); no(e instanceof Error ? e : new Error("Jira did not answer")); });
  });
}

const projectOf = (t: ScopeCard): string => (t.customId ?? t.id).split("-")[0]?.toUpperCase() ?? "";
const hasSprints = (c: JiraBoardContext): boolean => !!c.sprint || !!c.futures?.length || !!c.next;
const holds = (c: JiraBoardContext, id: string | undefined): boolean => !!id && (c.sprint?.id === id || !!c.futures?.some((x) => x.id === id));

export async function resolveBulkSprints(cards: readonly ScopeCard[], view: JiraBoardContext | null, reads: ScopeReads, ms = READ_MS): Promise<Scope> {
  if (!cards.length) return { ok: true, choices: [], boards: 0, note: null };
  if (view) return { ok: true, choices: sprintChoices(view), boards: 1, note: null };
  try {
    const perProject = new Map<string, Promise<{ id: string; ctx: JiraBoardContext }[]>>();
    const boardsOf = (key: string) => {
      let p = perProject.get(key);
      if (!p) {
        p = (async () => {
          const r = await reads.projectBoards(key);
          if (!r.ok) throw new Error("Jira did not answer the board list");
          const out: { id: string; ctx: JiraBoardContext }[] = [];
          for (const b of (r.boards ?? []).slice(0, BOARDS_MAX)) {
            const ctx = await reads.boardContext(`board:${b.id}`);
            if (!ctx.ok) throw new Error(`Jira did not answer for board ${b.name}`);
            if (hasSprints(ctx)) out.push({ id: b.id, ctx });
          }
          return out;
        })();
        perProject.set(key, p);
      }
      return p;
    };
    const sets = await withTimeout(Promise.all(cards.map(async (t): Promise<CardSet> => {
      const all = await boardsOf(projectOf(t));
      const own = all.filter((b) => holds(b.ctx, t.sprintId));
      const use = own.length ? own : all;
      const seen = new Map<string, SprintChoice>();
      for (const b of use) for (const s of sprintChoices(b.ctx)) if (!seen.has(s.id)) seen.set(s.id, s);
      return { boardIds: use.map((b) => b.id), sprints: [...seen.values()] };
    })), ms);
    return { ok: true, ...sharedSprints(sets) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Jira did not answer" };
  }
}
