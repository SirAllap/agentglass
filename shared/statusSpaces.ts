/*
 * Which spaces the status picker should lead with.
 *
 * Get Spaces answers for the whole workspace: ten spaces, most of them nobody's
 * business to this person. Measured on a real workspace, his eighteen statuses
 * were one space's and the picker buried them among nine others, with the
 * first space in the answer selected. The cards the app has ALREADY read each
 * carry their space and their status, so where the work lives costs no request.
 *
 * The person may also CHOOSE which spaces count. The rest are ignored, not
 * deleted: they keep their place in the answer (marked `counted: false`) so the
 * pane can list them and count one again, and they stay out of the pickers, the
 * selector and the coverage. Nothing chosen means "where my cards live".
 *
 * Limits, chosen: a list that overrides its space's statuses is only known by
 * the statuses its cards wear (the full set is one GET /list/{id} away, and
 * nothing here asks). A person with no cards read yet gets every space back,
 * with a sentence saying why.
 */
import type { ClickUpSpace, ProviderTask, SpaceStatus } from "./providers.ts";

type Seen = Pick<ProviderTask, "spaceId" | "listId" | "list" | "status" | "statusKind" | "statusColor">;

const low = (s: string) => s.trim().toLowerCase();
const LEGACY = /\b(legacy|deprecated|do not use|archived?)\b/i;

export interface StatusSpaces {
  spaces: ClickUpSpace[];
  /** "chosen": the person's own pick; "tasks": where the cards live; "spaces": nothing to go on. */
  source: "chosen" | "tasks" | "spaces";
  /** Said to the person when the answer is not narrowed. */
  note?: string;
}

export function statusSpaces(all: readonly ClickUpSpace[], tasks: readonly Seen[], chosen: readonly string[] = []): StatusSpaces {
  const spaces = all.map((s) => ({ ...s, ...(LEGACY.test(s.name) ? { legacy: true } : null) }));
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const cards = new Map<string, number>();
  const overrides = new Map<string, { space: ClickUpSpace; listName: string; seen: Map<string, SpaceStatus>; n: number }>();
  for (const t of tasks) {
    const sp = t.spaceId ? byId.get(t.spaceId) : undefined;
    if (!sp) continue;
    cards.set(sp.id, (cards.get(sp.id) ?? 0) + 1);
    if (!t.status || sp.statuses.some((x) => low(x.status) === low(t.status))) continue;
    const key = t.listId ?? t.list ?? "?";
    const o = overrides.get(key) ?? { space: sp, listName: t.list ?? "a list", seen: new Map(), n: 0 };
    o.n++;
    if (!o.seen.has(low(t.status))) {
      o.seen.set(low(t.status), { status: t.status, type: t.statusKind === "open" ? "open" : t.statusKind === "done" ? "done" : "custom", ...(t.statusColor ? { color: t.statusColor } : {}) });
    }
    overrides.set(key, o);
  }
  const mineIds = new Set(cards.keys());
  const picked = new Set(chosen.filter((id) => byId.has(id)));
  const gone = chosen.length > 0 && picked.size === 0;
  const source: StatusSpaces["source"] = picked.size ? "chosen" : mineIds.size ? "tasks" : "spaces";
  const counted = (id: string) => (source === "chosen" ? picked.has(id) : source === "tasks" ? mineIds.has(id) : true);
  const lists: ClickUpSpace[] = [...overrides.entries()].map(([key, o]) => ({
    id: `list:${key}`, name: `${o.space.name} / ${o.listName}`, statuses: [...o.seen.values()], mine: true, cards: o.n, fromList: true,
    spaceId: o.space.id, counted: counted(o.space.id),
  }));
  const rank = (s: ClickUpSpace) => (s.counted ? 0 : 2) + (s.legacy ? 1 : 0);
  const body = spaces.map((s) => ({ ...s, ...(source === "spaces" ? null : mineIds.has(s.id) ? { mine: true, cards: cards.get(s.id)! } : { mine: false }), counted: counted(s.id) }));
  body.sort((a, b) => rank(a) - rank(b) || (b.cards ?? 0) - (a.cards ?? 0));
  const out: ClickUpSpace[] = [];
  for (const sp of body) {
    out.push(sp);
    out.push(...lists.filter((l) => l.spaceId === sp.id));
  }
  const note = source === "spaces"
    ? (tasks.length
      ? "None of your cards say which space they are in, so every space is counted."
      : "No cards have been read yet, so every space is counted. Open your cards once and this narrows to your own.")
    : gone ? "The spaces you chose are no longer in this workspace, so the ones your cards live in are counted." : undefined;
  return { spaces: out, source, ...(note ? { note } : null) };
}
