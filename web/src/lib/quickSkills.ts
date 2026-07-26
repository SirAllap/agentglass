// The handful of skills worth putting one click away.
//
// The chat already knows every skill on the machine — the `/` menu lists them —
// but knowing they exist and reaching for one are different problems. Fifty
// entries behind a keystroke you have to remember is a reference, not a
// shortcut.

const PINS_KEY = "agentglass.chat.pinnedSkills";

/** Skills pinned by hand, in the order they were pinned.
 *
 *  Order is preserved rather than sorted, because a pin is a statement about
 *  where you want something to be. Re-sorting them by usage would defeat the
 *  point of having pinned them in the first place. */
export function pinnedSkills(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PINS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
  } catch { return []; }
}

export function setPinnedSkills(names: string[]): void {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(names)); } catch { /* private mode */ }
}

/** Pin or unpin one, returning the new list. */
export function togglePinnedSkill(name: string): string[] {
  const cur = pinnedSkills();
  const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
  setPinnedSkills(next);
  return next;
}

/** What a skill needs to be rankable. Deliberately narrow so the strip does not
 *  care where the data came from — the server's `SkillInfo` satisfies it. */
export interface RankableSkill { name: string; calls: number; last_used?: number | null }

/**
 * The strip's contents: what you pinned, then what you actually use.
 *
 * Pins come first and in full, even past the limit — you asked for those by
 * name, and silently dropping the fifth one you pinned would be worse than a
 * slightly longer strip. Usage fills whatever is left.
 *
 * A skill with no recorded runs is never auto-suggested. Ranking on `calls`
 * alone would otherwise put fifty never-used skills in an arbitrary order and
 * call the first five "most used", which is a claim the data does not support.
 * Ties break on recency, then name, so the strip does not reshuffle itself
 * between renders for no reason.
 */
export function quickSkills<T extends RankableSkill>(all: T[], pinned: string[], limit = 5): T[] {
  const byName = new Map(all.map((s) => [s.name, s]));
  const out: T[] = [];
  for (const name of pinned) {
    const s = byName.get(name);
    // A pin for a skill that no longer exists is dropped rather than rendered
    // as a chip that inserts a command nothing will answer.
    if (s) out.push(s);
  }
  const used = all
    .filter((s) => s.calls > 0 && !pinned.includes(s.name))
    .sort((a, b) => b.calls - a.calls || (b.last_used ?? 0) - (a.last_used ?? 0) || a.name.localeCompare(b.name));
  for (const s of used) {
    if (out.length >= Math.max(limit, pinned.length)) break;
    out.push(s);
  }
  return out;
}
