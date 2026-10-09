/*
 * The pull requests of a card: what to ask, and how each row says whose it is.
 *
 * `/clickup/prs` finds them two ways — the card's own GitHub field NAMES one
 * (`stated`), a search for its id GUESSES at the rest — and it already says who
 * wrote each and whether that is the signed-in account. The phone asked with
 * the card's id alone, so a pull request named in the field was lost when its
 * branch did not carry the id, and two rows looked alike whoever's they were.
 */
import type { CardPr, ProviderTask } from "../../../shared/providers.ts";
import { rootForTask } from "../../../shared/rootForTask.ts";

/** The query for `/clickup/prs`: the card, its GitHub field when it has one,
 *  and the checkout named like its list when the computer has one. */
export function cardPrsQuery(
  card: Pick<ProviderTask, "id" | "customId" | "custom" | "list">,
  repos: { root: string; name: string }[],
): string {
  const field = card.custom?.find((c) => /github/i.test(c.name))?.value ?? "";
  const root = rootForTask(card.list ?? null, repos, null);
  const q = new URLSearchParams({ card: card.customId || card.id });
  if (field) q.set("field", field);
  if (root) q.set("root", root);
  return q.toString();
}

/** One row's second line: its state, then whose it is. */
export function prLine(pr: CardPr): string {
  // A row the card's field names can come with no state at all ("").
  const state = pr.draft ? "Draft" : pr.state ? pr.state[0] + pr.state.slice(1).toLowerCase() : null;
  const owner = pr.mine ? "yours" : pr.author ? `@${pr.author}` : null;
  const found = !pr.stated && !owner ? "found by search" : null;
  return [state, owner, found].filter(Boolean).join(" · ");
}

/** The long warning under the list, only when some row really is a guess about
 *  an unknown author: a row that names its author has told you what it is. */
export function needsFoundNote(prs: readonly CardPr[]): boolean {
  return prs.some((pr) => !pr.stated && !pr.mine && !pr.author);
}
