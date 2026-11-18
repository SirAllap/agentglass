/*
 * Reactions on a card comment, as pure decisions both sides share.
 *
 * ClickUp sends a reaction per person (`{ reaction, user }`); the pane draws one
 * chip per emoji with a count, read-only (ClickUp documents no reaction write). Jira has none in its public REST, so a Jira
 * comment never carries them and draws no chips.
 */
export interface ReactionChip { emoji: string; count: number; /** The connected account is one of them. */ mine: boolean; who: string[] }

interface RawReaction { reaction?: unknown; user?: { id?: string | number; username?: string } }

/** One chip per emoji, in the order each emoji first appeared. Rows with no emoji are dropped. */
export function groupReactions(raw: unknown, me?: string): ReactionChip[] {
  if (!Array.isArray(raw)) return [];
  const chips = new Map<string, ReactionChip>();
  for (const r of raw as RawReaction[]) {
    const emoji = typeof r?.reaction === "string" ? r.reaction.trim() : "";
    if (!emoji) continue;
    const chip = chips.get(emoji) ?? { emoji, count: 0, mine: false, who: [] };
    chip.count++;
    if (me && String(r.user?.id ?? "") === me) chip.mine = true;
    if (r.user?.username) chip.who.push(r.user.username);
    chips.set(emoji, chip);
  }
  return [...chips.values()];
}

/** The hover line: who reacted, or the count when ClickUp named nobody. */
export function reactionTip(chip: ReactionChip): string {
  return chip.who.length ? chip.who.join(", ") : `${chip.count} ${chip.count === 1 ? "reaction" : "reactions"}`;
}
