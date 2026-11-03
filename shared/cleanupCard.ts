/*
 * What an agent's "clean up this merged PR" request shows the person.
 *
 * The request travels on the settings door's card as `diff: string[]`, the one
 * shape every card already has, so the door's public shape does not change. The
 * server writes the lines (`cleanupCardLines`) and the window reads them back
 * (`parseCleanupCard`); both live here so they cannot drift:
 *
 *   clean up the local leftovers of #322 Retry queue         the title line
 *   plan items=10 bytes=6200000000 repo=acme/orbit slug=ORBIT-1042 merged=1788000000000
 *   docker-image: acme-orbit:ORBIT-1042 [docker 4100000000]  one per item, in plan order
 *
 * The summary line carries the totals of the WHOLE plan, because the item lines
 * are cut at CARD_ITEMS; the card says how many are not listed.
 */
export interface CardItem { kind: string; target: string; group: string; bytes: number }
export interface CardFacts { pr: number; title: string; repo: string; slug: string; mergedAt: number | null; items: readonly CardItem[] }

/** The door shows at most 60 lines; the title and the summary take two. */
export const CARD_ITEMS = 50;

export function cleanupCardLines(f: CardFacts): string[] {
  const bytes = f.items.reduce((n, i) => n + (i.bytes > 0 ? i.bytes : 0), 0);
  return [
    `clean up the local leftovers of #${f.pr} ${f.title}`,
    `plan items=${f.items.length} bytes=${bytes} repo=${f.repo.replace(/\s/g, "")} slug=${f.slug.replace(/\s/g, "")} merged=${f.mergedAt ?? 0}`,
    ...f.items.slice(0, CARD_ITEMS).map((i) => `${i.kind}: ${i.target} [${i.group} ${Math.max(0, Math.round(i.bytes))}]`),
  ];
}

export interface ParsedCard {
  pr: number; title: string; repo: string; slug: string; mergedAt: number | null;
  itemCount: number; totalBytes: number;
  groups: { group: string; items: number; bytes: number }[];
  /** The item lines the door kept; fewer than `itemCount` when the plan was long. */
  items: CardItem[];
}

/** Null when the lines are not ones `cleanupCardLines` wrote: the window then draws the plain card. */
export function parseCleanupCard(diff: readonly string[]): ParsedCard | null {
  const t = /^clean up the local leftovers of #(\d+) ?(.*)$/.exec(diff[0] ?? "");
  const s = /^plan items=(\d+) bytes=(\d+) repo=(\S*) slug=(\S*) merged=(\d+)$/.exec(diff[1] ?? "");
  if (!t || !s) return null;
  const items: CardItem[] = [];
  for (const line of diff.slice(2)) {
    const m = /^(\S+): (.*) \[(\S+) (\d+)\]$/.exec(line);
    if (m) items.push({ kind: m[1]!, target: m[2]!, group: m[3]!, bytes: Number(m[4]) });
  }
  const by = new Map<string, { group: string; items: number; bytes: number }>();
  for (const i of items) {
    const g = by.get(i.group) ?? { group: i.group, items: 0, bytes: 0 };
    g.items++; g.bytes += i.bytes; by.set(i.group, g);
  }
  return {
    pr: Number(t[1]), title: t[2]!, repo: s[3]!, slug: s[4]!, mergedAt: Number(s[5]) > 0 ? Number(s[5]) : null,
    itemCount: Number(s[1]), totalBytes: Number(s[2]), groups: [...by.values()], items,
  };
}
