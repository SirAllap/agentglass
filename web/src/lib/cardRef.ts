/*
 * The card a pull request came from.
 *
 * ClickUp already draws the other half of this link: open a card and its
 * sidebar lists the pull requests that mention it. Standing on the pull request
 * there is nothing — the card id is sitting in the branch name and in the body,
 * and reading it means selecting text and pasting it somewhere else.
 *
 * So it is read here, from what a pull request already carries. Two sources,
 * and they are not equally trustworthy:
 *
 *   the body's ClickUp address   certain — nothing else writes clickup.com
 *   an id in the branch/title    a convention, and other trackers share it
 *
 * That difference is reported rather than smoothed over (`from`), because the
 * caller has to decide with it: a Jira shop whose branches are `ABC-12-thing`
 * must not be shown a ClickUp mark for a card that does not exist.
 *
 * What is deliberately NOT read is any card a TEMPLATE mentions, and that is
 * not a precaution — it is measured. Across fourteen real pull requests, twelve
 * resolved to the same card, because the checklist every one of them is written
 * from links a card of its own ("A/B testing only — see ORBIT-3306"), and it is
 * above the reference. So boilerplate is skipped by shape rather than by
 * wording: template links live inside checklist items, a card reference is
 * written as a line of its own. See `addresses`.
 */

export interface CardRef {
  /** What the chip says. The human id when the pull request has one, because
   *  `ORBIT-1042` is what people say out loud; ClickUp's internal id otherwise. */
  label: string;
  /** What the finder is handed. Not always the label: an address gives an
   *  unambiguous id, and using it skips the custom-id lookup entirely. */
  query: string;
  /** ClickUp's own address, when the body carried one. The way out when this
   *  machine has no ClickUp connected to open the card in. */
  url?: string;
  /** Which evidence this rests on. `url` is certain; the rest is a convention
   *  and needs corroborating before a ClickUp mark is put on it. */
  from: "url" | "branch" | "title";
}

/**
 * A ClickUp task address.
 *
 * Two shapes in the wild: `/t/<id>` and `/t/<team>/<id>`, the second being what
 * you get when the workspace has custom ids switched on. When there are two
 * segments the LAST is the task — the first is the workspace, and handing that
 * to a task lookup asks for a card whose id is a team number.
 */
const CU_URL = /https?:\/\/(?:[\w-]+\.)*clickup\.com\/t\/([\w-]+)(?:\/([\w-]+))?/i;

/**
 * The card addresses a body means, which is not every address in it.
 *
 * Lines that are a list item or a quotation are skipped. That is where a
 * template puts its own links and where a reply quotes somebody else's, and
 * both are in the body of every pull request the template made rather than in
 * the one you are reading. What is left is a reference somebody wrote for THIS
 * pull request — on its own line, bare or as a link.
 *
 * Two different cards surviving that means the body names two, and this cannot
 * tell which is the one. It says so by returning neither: a chip that opens the
 * wrong card is worse than no chip, because it is believed.
 */
function addresses(body: string): { id: string; url: string }[] {
  const found = new Map<string, string>();
  for (const line of (body || "").split(/\r?\n/)) {
    if (/^\s*(?:[-*+>]|\d+[.)])\s/.test(line)) continue;
    const m = CU_URL.exec(line);
    // `/t/<team>/<id>` — the second capture is the task. With one segment the
    // first IS the task, and handing a team number to a task lookup finds
    // nothing.
    if (m) found.set(m[2] ?? m[1], m[0]);
  }
  return [...found].map(([id, url]) => ({ id, url }));
}

/**
 * A human card id: capitals, a hyphen, digits.
 *
 * Every bound here is doing the same job — keeping ordinary branch names out of
 * a feature that otherwise puts a ClickUp mark on a Renovate PR. None of them
 * are hypothetical:
 *
 *   fix/UTF-8-decode                    one digit, so not an id
 *   release/v2-1409                     lower case, and a digit in the prefix
 *   .../types/node-22-10-1              lower case — this is the one that bites
 *
 * Capitals is the load-bearing rule, and it is not arbitrary: an id is a proper
 * noun and gets written as one, by ClickUp's own "create branch", by every
 * template, and by anybody copying it out of the address bar. Somebody who
 * lower-cases theirs loses the chip on the branch — and keeps it via the
 * address in the body, which is where most of these come from anyway.
 *
 * The id must start the string or follow a separator, so `agent-v2` cannot lend
 * its tail to something that looks like an id. What follows it may be a hyphen
 * — a branch is `ORBIT-1042-what-it-was-about` — but not a word character, so a
 * number is never matched half-way.
 */
const HUMAN_ID = /(?:^|[/_\-\s[(])([A-Z]{2,10})-(\d{2,})(?!\w)/;

const human = (s: string): string | null => {
  const m = HUMAN_ID.exec(s || "");
  return m ? `${m[1]}-${m[2]}` : null;
};

/**
 * What card this pull request is about, as far as it is willing to say.
 *
 * Null when it says nothing, which is the common case on a repository that
 * does not work this way — and the reason the chip has to be able to not exist
 * rather than render an empty slot.
 */
export function cardRef(pr: { headRefName?: string; title?: string; body?: string }): CardRef | null {
  // The label people recognise, wherever it turns up. Branch first: it is
  // written by the tool that cut it, so it is the id far more often than a
  // title somebody typed.
  const branch = human(pr.headRefName ?? "");
  const named = branch ?? human(pr.title ?? "");
  const [only, ...rest] = addresses(pr.body ?? "");

  if (only && !rest.length) {
    return { label: named ?? only.id, query: only.id, url: only.url, from: "url" };
  }
  if (!named) return null;
  return { label: named, query: named, from: branch ? "branch" : "title" };
}

/**
 * Does this id belong to the workspace we are connected to?
 *
 * The prefix is derived from cards already read rather than configured — see
 * the server's `knownCardPrefix`. Unknown means nothing has been read yet, and
 * the honest answer then is yes: refusing to show a card link because a board
 * has not been opened this session would make the feature come and go.
 */
export function looksLikeOurs(ref: CardRef, prefix: string | undefined): boolean {
  if (ref.from === "url") return true;
  if (!prefix) return true;
  return ref.label.toUpperCase().startsWith(prefix.toUpperCase());
}
