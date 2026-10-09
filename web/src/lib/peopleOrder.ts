import type { ListMember } from "../../../shared/providers.ts";

/*
 * Who the people picker lists first, in one place.
 *
 * It was written inline in the card view, and the pull request's copy of the
 * picker then listed the same people alphabetically with the ones already on
 * the card scattered through them. Both read this now: the people already on
 * the card or the board, then you, then everyone else by name; a name with
 * nothing in it is not a choice and is left out.
 */
export function orderMembers(members: ListMember[] | null, onBoard: ReadonlySet<number>, needle = ""): ListMember[] {
  const q = needle.trim().toLowerCase();
  return (members ?? [])
    .filter((m) => m.name && (!q || m.name.toLowerCase().includes(q)))
    .sort((a, b) => {
      const ah = onBoard.has(a.id) ? 0 : 1, bh = onBoard.has(b.id) ? 0 : 1;
      if (ah !== bh) return ah - bh;
      if (a.me !== b.me) return a.me ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
