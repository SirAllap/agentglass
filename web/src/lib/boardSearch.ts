import type { ProviderTask } from "../../../shared/providers.ts";

/**
 * What the board's search box looks at.
 *
 * It used to look at the title and nothing else, which made it lie about the
 * one thing every row shows underneath the title: the card id. Typing the id
 * printed on the row you are staring at answered "Not on this board" and
 * offered to fetch it from the service — for a card already on screen.
 *
 * The rule that replaces it: you can search for anything the row DRAWS. That
 * is the only rule a person can hold in their head, and it needs no
 * documenting because the row itself documents it.
 */
function haystack(t: ProviderTask): string {
  const bits: (string | null | undefined)[] = [
    t.title,
    t.customId,
    /* The internal id too. Nobody types it from memory, but it is what a URL
       and a `gh` branch name carry, so a paste lands on the right card. */
    t.id,
    t.status,
    t.sprint,
    t.list,
    ...t.tags,
    ...(t.people ?? []).flatMap((p) => [p.name, p.initials]),
    /* `assignees` as well: `people` is the richer shape and may be absent on a
       provider that only reports names. */
    ...t.assignees,
  ];
  return bits.filter(Boolean).join(" ").toLowerCase();
}

/**
 * Every word has to land somewhere, but not in the same place and not in
 * order.
 *
 * Typing "search support" for "Support Tool Backend Missing Search Field" is
 * what people actually do — they remember two words, not the phrase. A single
 * `includes` of the whole query fails that, and failing it is what sends
 * someone to the service's own search instead.
 */
export function matchesQuery(t: ProviderTask, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = haystack(t);
  return terms.every((w) => hay.includes(w));
}
