/*
 * A FILTER YOU BUILD, rather than a row of chips somebody chose for you.
 *
 * The chips along the top of the board are the tags the loaded cards happen to
 * carry, plus `mine`, plus a status picker. That answers "show me the cards
 * tagged X" and cannot answer "show me the cards of one squad", which is what
 * was asked for — a squad is a CUSTOM FIELD, so it had a column and no chip:
 * the board could say which squad every card belonged to and could not show
 * you one squad's.
 *
 * The general shape is the tracker's own, and it is the right one:
 *
 *     Where  [Status]  [is]      [READY FOR ENGINEERING]
 *     AND    [Squad]   [is not]  [Crimson, Olive]
 *
 * One join for the whole set rather than per row, which is also what the
 * tracker does. Nested groups are the next thing after that and are not here:
 * everything anybody has actually asked for is one flat list, and a builder
 * that can express `(a OR b) AND (c OR d)` before anybody needs it is a lot of
 * screen to look past.
 *
 * FIELDS ARE DISCOVERED, never listed. Which fields exist depends on the
 * board — a workspace's custom fields are its own — so they are derived from
 * the cards that are loaded, and a board with no squad field simply has no
 * squad row to offer. The alternative is a menu naming fields this board does
 * not have.
 */
import type { ProviderTask } from "../../../../shared/providers.ts";

/*
 * FOUR OPERATORS, and the last two take no values.
 *
 * "is set" / "is not set" are the ones that answer a question the other two
 * cannot: which cards have nobody assigned, which have no squad, which never
 * got a due date. On a board being triaged that is most of the work, and with
 * only is/is-not the closest you could get was picking every value and
 * inverting — which stops being true the moment somebody adds a value.
 */
export type Op = "is" | "not" | "set" | "unset";
export type Rule = { id: string; field: string; op: Op; values: string[] };

/** Whether an operator needs values chosen before it means anything. */
export const takesValues = (op: Op): boolean => op === "is" || op === "not";

export const OPS: { value: Op; label: string }[] = [
  { value: "is", label: "is" },
  { value: "not", label: "is not" },
  { value: "set", label: "is set" },
  { value: "unset", label: "is not set" },
];
export type FilterSet = { join: "and" | "or"; rules: Rule[] };

export const EMPTY: FilterSet = { join: "and", rules: [] };

export interface FieldSpec {
  key: string;
  label: string;
  options: { value: string; label: string; color?: string }[];
}

/** The values one card has for one field. A list, because a card has several
 *  tags and several assignees, and "is" on a multi-valued field means "has". */
export function valuesOf(t: ProviderTask, key: string): string[] {
  if (key === "status") return [t.status];
  if (key === "tags") return t.tags;
  if (key === "priority") return t.priority ? [t.priority] : [];
  if (key === "assignee") return t.assignees;
  if (key === "sprint") return t.sprint ? [t.sprint] : [];
  if (key === "list") return t.list ? [t.list] : [];
  if (key.startsWith("cf:")) {
    const want = key.slice(3);
    return (t.custom ?? []).filter((c) => c.name === want && c.value).map((c) => c.value);
  }
  return [];
}

/**
 * Which fields this board actually has, and what each one's values are.
 *
 * Ordered so the two people reach for first are first, then whatever the
 * workspace invented. Within a field the values are ordered by how many open
 * cards carry them: a value on three cards is a more useful thing to offer
 * than one on none, and a board with forty statuses is unreadable alphabetical.
 */
export function fieldsOf(tasks: ProviderTask[]): FieldSpec[] {
  const bag = (pick: (t: ProviderTask) => { value: string; label?: string; color?: string }[]) => {
    const seen = new Map<string, { value: string; label: string; color?: string; n: number }>();
    for (const t of tasks) {
      for (const v of pick(t)) {
        if (!v.value) continue;
        const had = seen.get(v.value) ?? { value: v.value, label: v.label ?? v.value, color: v.color, n: 0 };
        if (t.statusKind !== "done") had.n++;
        if (!had.color && v.color) had.color = v.color;
        seen.set(v.value, had);
      }
    }
    return [...seen.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
      .map(({ value, label, color }) => ({ value, label, ...(color ? { color } : {}) }));
  };

  const out: FieldSpec[] = [];
  const push = (key: string, label: string, options: FieldSpec["options"]) => {
    if (options.length) out.push({ key, label, options });
  };

  push("status", "Status", bag((t) => [{ value: t.status, color: t.statusColor }]));
  push("tags", "Tags", bag((t) => t.tags.map((x) => ({ value: x }))));
  push("priority", "Priority", bag((t) => (t.priority ? [{ value: t.priority }] : [])));
  push("assignee", "Assignee", bag((t) => t.assignees.map((x) => ({ value: x }))));
  push("sprint", "Sprint", bag((t) => (t.sprint ? [{ value: t.sprint }] : [])));
  push("list", "List", bag((t) => (t.list ? [{ value: t.list }] : [])));

  /* Every custom field that has values, named as the workspace names it. The
     "(DO NOT EDIT!!!)" kind of parenthesis is a note to whoever maintains the
     field rather than part of its name — the card already strips it and so
     does this, or the menu reads as shouting. */
  const customNames = new Set<string>();
  for (const t of tasks) for (const c of t.custom ?? []) if (c.value) customNames.add(c.name);
  for (const name of [...customNames].sort()) {
    push(`cf:${name}`, name.replace(/\s*\(.*\)\s*$/, ""),
      bag((t) => (t.custom ?? []).filter((c) => c.name === name && c.value).map((c) => ({ value: c.value, color: c.color ?? undefined }))));
  }
  return out;
}

/** Does one card survive one rule? A rule with no values chosen yet is still
 *  being written and filters nothing — the alternative is a board that empties
 *  the moment you add a row. */
function passes(t: ProviderTask, r: Rule): boolean {
  if (!r.field) return true;
  const mine = valuesOf(t, r.field);
  /* "set" and "unset" ask whether the field has ANY value, so they are
     answered before values are consulted — and they are complete without
     any, which is why `live` below cannot simply require values. */
  if (r.op === "set") return mine.length > 0;
  if (r.op === "unset") return mine.length === 0;
  if (!r.values.length) return true;
  const has = mine.some((v) => r.values.includes(v));
  return r.op === "not" ? !has : has;
}

/** A rule that is doing something. `set`/`unset` need no values; the other two
 *  are still being written until they have some. */
const isLive = (r: Rule): boolean => !!r.field && (!takesValues(r.op) || r.values.length > 0);

export function apply(tasks: ProviderTask[], f: FilterSet): ProviderTask[] {
  const live = f.rules.filter(isLive);
  if (!live.length) return tasks;
  return tasks.filter((t) => (f.join === "or"
    ? live.some((r) => passes(t, r))
    : live.every((r) => passes(t, r))));
}

/** How many rules are actually doing something — for the count on the button.
 *  A half-written row is not a filter and must not be counted as one. */
export const liveCount = (f: FilterSet): number => f.rules.filter(isLive).length;
