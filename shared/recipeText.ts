/**
 * Filling a prompt's placeholders in.
 *
 * In `shared/` for the reason `reviewSuggest.ts` is: two sides need the same
 * answer and a disagreement between them is invisible. The server expands the
 * review prompts it sends to an agent it launches; the panel expands the one it
 * hands to a tmux window itself. Two copies of a substitution table drift on the
 * first placeholder either side adds.
 */
import type { ReviewRecipeContext } from "./types.ts";

/**
 * What every prompt can say, and what each one means:
 *
 *   {number}  17598              the pull request
 *   {repo}    acme/shop          owner/name, as gh takes it
 *   {head}    a1b2c3d            the commit it is pinned to — a push mid-review
 *                                must not swap the code underneath the answer
 *   {branch}  fix/checkout-total the head branch
 *   {title}   …                  the pull request title
 *   {author}  someone            the login that opened it
 *   {url}     https://…          its page
 *   {since}   9f8e7d6            the commit YOUR last review was written
 *                                against, or empty when you have not reviewed it
 *   {card}    ORBIT-1042         the tracker id in the branch or title, if any
 *   {cardUrl} https://…          that card's page, when the tracker links
 *   {who}     Alex Doe           who the message is for, by name
 *   {note}    …                  whatever was typed in the box beside the button
 *
 * An unknown placeholder is left exactly as typed: a prompt that says `{foo}`
 * meant to say it, and silently deleting a brace from somebody's careful
 * wording is worse than showing it.
 */
export function expandRecipe(body: string, ctx: ReviewRecipeContext): string {
  return body.replace(/\{(number|repo|head|branch|title|author|url|since|card|cardUrl|who|note)\}/g, (whole, key: string) => {
    const v = {
      number: String(ctx.number),
      repo: ctx.repo,
      head: ctx.head,
      branch: ctx.branch,
      title: ctx.title,
      author: ctx.author,
      url: ctx.url,
      since: ctx.since ?? "",
      card: ctx.card ?? "",
      cardUrl: ctx.cardUrl ?? "",
      who: ctx.who ?? "",
      note: ctx.note ?? "",
    }[key];
    return v === undefined ? whole : v;
  });
}
