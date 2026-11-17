/*
 * Which of your skills know what a ClickUp card is.
 *
 * You have a hundred-odd skills and nine of them are about ClickUp; a menu that
 * offered all hundred would be a menu nobody opens twice. So they are matched
 * rather than configured — a list you had to maintain by hand would be wrong
 * the first time you added one.
 *
 * Matched on the DESCRIPTION as well as the name, deliberately. Two of the nine
 * are not called `clickup-anything` — one compares a chat channel against its
 * specs, another sweeps a report stream — and both say in their own description
 * that they take a card. Matching only the name would hide exactly the two you
 * would never think to look for.
 *
 * ── in shared/ because two products ask the same question ────────────────
 * It began in `web/src/lib/`, when the desk was the only place a card could be
 * handed over. The phone now offers the same menu, and a second copy of this
 * would be a second answer to "which skills take a card" — the menus would
 * agree on the day they were written and drift from there. The regex, the
 * grouping and the invocation line are one thing, in one file, and both
 * products import it.
 */
import { itemFromUrl } from "./taskref.ts";
import type { SkillInfo } from "./types.ts";

/** `cu` on its own is a word in too many places; as a hyphenated part of a
 *  skill's name it is unambiguous, and that is how the ones here spell it. */
export const DEFAULT_CARD_SKILL_PATTERN = "clickup|\\bcu-|-cu\\b";
const MENTIONS = new RegExp(DEFAULT_CARD_SKILL_PATTERN, "i");

/**
 * The pattern a workspace chose, or the shipped one. A habit of naming (`acme-card`)
 * is a person's, so it is a setting; an empty or uncompilable source is the
 * default rather than a menu that matches nothing, because the server refuses to
 * save one but a hand-edited file can still carry it.
 */
function mentions(pattern?: string): RegExp {
  const src = (pattern ?? "").trim();
  if (!src || src === DEFAULT_CARD_SKILL_PATTERN) return MENTIONS;
  try { return new RegExp(src, "i"); } catch { return MENTIONS; }
}

export function cardSkills(all: SkillInfo[], pattern?: string): SkillInfo[] {
  const re = mentions(pattern);
  return all
    .filter((s) => re.test(s.name) || re.test(s.description ?? ""))
    .sort((a, b) => {
      // The ones named for it first — they are the ones being looked for — then
      // alphabetically, so the list does not reshuffle between openings.
      const an = namedForIt(a, pattern) ? 0 : 1, bn = namedForIt(b, pattern) ? 0 : 1;
      return an - bn || a.name.localeCompare(b.name);
    });
}

/**
 * Named for it, versus merely mentioning it.
 *
 * On a real machine: 103 skills, 26 that say ClickUp somewhere, 10 named for
 * it. Tightening the filter to "definitely takes a card" was tried against that
 * set and threw away `requirements-check`, `task-context` and
 * `fix-tasks-with-agent-teams` — three that plainly do — while keeping others
 * that plainly do not. There is no phrasing that separates them reliably,
 * because the descriptions were written for people.
 *
 * So nothing is guessed away. They are grouped, the obvious ones first, and the
 * menu has a search box. A wrong guess hides a skill somebody needs; a group
 * heading costs a line.
 */
export function namedForIt(s: SkillInfo, pattern?: string): boolean {
  const re = mentions(pattern);
  // Only the shipped pattern has a spelling of "named for it" narrower than
  // "mentions it"; a custom one is the person's own word for it, so the name
  // matching it is the whole claim.
  return re === MENTIONS ? /^(clickup|cu)-/i.test(s.name) : re.test(s.name);
}

/**
 * The line that goes to the agent.
 *
 * A skill is invoked the way it is invoked in the terminal — `/name` and then
 * its argument — because that is the string these skills were written against
 * and the one their own descriptions quote.
 *
 * The id is the HUMAN one when the workspace has them. Skills here ask for that
 * shape by name, and handing over the internal id instead fails in the least
 * useful way there is: the card exists and the tool cannot find it.
 */
export function skillCommand(skill: string, card: { id: string; customId?: string }): string {
  const name = skill.startsWith("/") ? skill : `/${skill}`;
  return `${name} ${card.customId || card.id}`;
}

/** A card a tab can be named for: the id people use, and its own address when the tracker gave one. */
export interface CardTabCard {
  id: string;
  customId?: string;
  url?: string;
}

/** What the caller knows of where the tab opens. */
export interface CardTabContext {
  /** The project the tab opens in: a checkout's path, or just its folder name. */
  project?: string | null;
}

/**
 * The Jira key this card is about, or null.
 *
 * Only the card's own address makes it certain. An id's shape is not enough:
 * `ORBIT-1042` is also the shape of a ClickUp custom id. Asking `/jira/status`
 * was the obvious second opinion, and it made the name depend on an answer that
 * had not arrived — the same card was `orbit-1042` for a moment and
 * `orbit-ORBIT-1042` after that. A name cannot be a race, so the address
 * decides and nothing else does.
 */
export function cardJiraKey(card: CardTabCard): string | null {
  const at = itemFromUrl(card.url);
  return at?.tracker === "jira" ? at.id.toUpperCase() : null;
}

/** A project's own name, as a window can carry it: the folder's leaf, lower case, no dot. */
function projectPart(project: string | null | undefined): string {
  const leaf = (project ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  return leaf.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "").slice(0, 24);
}

/**
 * A tmux window name that says which card it is, and survives `tmux ls`.
 *
 * A card whose address is Jira is named `<project>-<JIRA-KEY>` —
 * `orbit-ORBIT-1042` — because that key is what everybody says out loud and
 * what the branch, the commit and the pull request all carry. A ClickUp card
 * keeps the id it has, even when that id has the shape of a key: the name is
 * one answer from the card alone, the same on every surface, before and after
 * any tracker status.
 */
export function windowName(card: CardTabCard, context: CardTabContext = {}): string {
  const key = cardJiraKey(card);
  if (key) {
    /* With no project named, the key's own prefix is the project: `ORBIT-1042`
       in `orbit` is `orbit-ORBIT-1042`, which is the name people read. */
    const project = projectPart(context.project) || (key.split("-")[0] ?? "").toLowerCase();
    return `${project}-${key}`.slice(0, 63);
  }
  const raw = (card.customId || card.id).toLowerCase();
  // tmux treats a dot as a pane separator in target strings, so a window named
  // with one is a window that cannot be selected by name later.
  return raw.replace(/[^a-z0-9-]/g, "").slice(0, 24) || "card";
}

/**
 * The modes a skill says it takes, read from its own invocation line.
 *
 * A skill such as `clickup-card-fix` advertises `[CARD-ID or URL] [autonomous | yolo]`, which is
 * the skill telling every reader that it has gears. Offering them means parsing
 * what it already publishes rather than keeping a list here — a list would be
 * wrong the day a skill grows a third mode, and wrong silently.
 *
 * Only a group that offers a CHOICE counts. `[CARD-ID or URL]` is a slot for
 * the card, not a menu, and the difference is the pipe.
 */
export function skillModes(argumentHint: string | null | undefined): string[] {
  if (!argumentHint) return [];
  const out: string[] = [];
  for (const m of argumentHint.matchAll(/\[([^\]]+)\]/g)) {
    const inside = m[1] ?? "";
    if (!inside.includes("|")) continue;
    for (const part of inside.split("|")) {
      const word = part.trim();
      // A single bare word each. Anything with spaces is prose describing a
      // slot, not an option somebody types.
      if (word && !/\s/.test(word) && !out.includes(word)) out.push(word);
    }
  }
  return out;
}

/**
 * The short name a team calls a card by.
 *
 * These titles start `T16 - …`, and "waiting on T2" is a sentence somebody can
 * act on where "waiting on ABC-21016" is a lookup. Falls back to the id when a
 * title has no such prefix, because inventing one would be worse than the id.
 */
export function shortName(title: string, fallback: string): string {
  const m = /^([A-Za-z]{1,3}\d{1,4})\s*[-–—:]/.exec((title || "").trim());
  return m?.[1] ?? fallback;
}
