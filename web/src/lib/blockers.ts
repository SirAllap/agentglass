/** An unresolved "is blocked by" link: a bare key, or the key with its status word. */
export type Blocker = string | { key: string; status?: string | undefined };

const keyOfBlocker = (b: Blocker): string => (typeof b === "string" ? b : b.key);
const statusOfBlocker = (b: Blocker): string => (typeof b === "string" ? "" : b.status ?? "");

/** The one wording for "what blocks this card", shared by the detail chip, the board tile and the list row. */
export function blockerWords(blockers: readonly Blocker[]): { first: string; short: string; chip: string; tip: string } | null {
  const first = blockers[0];
  if (!first) return null;
  const key = keyOfBlocker(first);
  const more = blockers.length - 1;
  const st = statusOfBlocker(first);
  return {
    first: key,
    short: more ? `Blocked by ${blockers.length} cards` : `Blocked by ${key}`,
    chip: `Blocked by ${key}${more ? ` and ${more} more` : st ? ` (${st})` : ""} - don't merge alone`,
    tip: blockers.map((b) => { const s = statusOfBlocker(b); return s ? `${keyOfBlocker(b)} (${s})` : keyOfBlocker(b); }).join(", "),
  };
}
