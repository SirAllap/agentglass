/*
 * Which Jira projects the workflow map is drawn from.
 *
 * A site can show a person a hundred projects and their cards sit in two. The
 * map judges a step against the projects that count: the ones the person chose,
 * else the ones their cards live in, else every project that was read. A project
 * that does not count stays in the answer (marked `counted: false`) so the page
 * can list it and count it again; it is never deleted from anywhere.
 *
 * Limit, chosen: only the projects with a card of the person's, and the ones
 * they chose, have their statuses read. Reading the statuses of every project on
 * a large site is one request each, for projects nobody here works in.
 */

export interface JiraUnitStatus { status: string; type: string }
export interface JiraUnit {
  id: string;
  name: string;
  statuses: JiraUnitStatus[];
  /** False for a project the person ignores. Absent counts. */
  counted?: boolean;
  /** How many of the person's cards sit here. */
  cards?: number;
}
export interface JiraUnits {
  spaces: JiraUnit[];
  /** "chosen": the person's own pick; "tasks": where the cards live; "spaces": nothing to go on, all of them. */
  source: "chosen" | "tasks" | "spaces";
  /** Said to the person when the answer is not narrowed. */
  note?: string;
}

export interface JiraProjectRead { key: string; name: string; statuses: { name: string; kind: "open" | "done" | "other" }[] }

/** What the map calls a status category: Jira's "other" is a status that is neither started nor finished. */
const typeOf = (k: "open" | "done" | "other"): string => (k === "done" ? "done" : k === "open" ? "open" : "custom");

/**
 * A project's statuses come in no board's order, so they are read left to right as work goes: open ones,
 * then the ones that are neither, then the ones that finish a card; within each, as the site lists them.
 */
const RANK = { open: 0, other: 1, done: 2 } as const;

export function jiraStatusUnits(read: readonly JiraProjectRead[], cards: Readonly<Record<string, number>>, chosen: readonly string[] = []): JiraUnits {
  const units: JiraUnit[] = read.map((p) => ({
    id: p.key,
    name: p.name,
    statuses: [...p.statuses].sort((a, b) => RANK[a.kind] - RANK[b.kind]).map((s) => ({ status: s.name, type: typeOf(s.kind) })),
    ...(cards[p.key] ? { cards: cards[p.key] } : null),
  }));
  const known = new Set(units.map((u) => u.id));
  const picked = chosen.filter((k) => known.has(k));
  if (picked.length) {
    return { source: "chosen", spaces: units.map((u) => (picked.includes(u.id) ? u : { ...u, counted: false })) };
  }
  const withCards = units.filter((u) => u.cards);
  if (withCards.length) {
    return { source: "tasks", spaces: units.map((u) => (u.cards ? u : { ...u, counted: false })) };
  }
  return { source: "spaces", spaces: units, note: "Your cards did not say which projects they live in, so every project is counted and none is picked for you." };
}

/**
 * Which projects are read: the chosen ones first, then those holding the most of the person's cards, each once, and
 * only ones the site lists. At most `max`; the rest are counted so the page can say so.
 */
export function pickProjects(chosen: readonly string[], cards: Readonly<Record<string, number>>, known: readonly string[], max: number): { read: string[]; omitted: number } {
  const byCards = Object.keys(cards).sort((a, b) => (cards[b] ?? 0) - (cards[a] ?? 0) || a.localeCompare(b));
  const all = [...new Set([...chosen, ...byCards])].filter((k) => known.includes(k));
  return { read: all.slice(0, max), omitted: Math.max(0, all.length - max) };
}
