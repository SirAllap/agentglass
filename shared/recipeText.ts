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
 *   {base}    main               conflict prompts: what the branch merges into
 *   {files}   a.ts\nb.ts         conflict prompts: the conflicted files, a line each
 *   {worktree} /path             conflict prompts: where the conflict is
 *
 * An unknown placeholder is left exactly as typed: a prompt that says `{foo}`
 * meant to say it, and silently deleting a brace from somebody's careful
 * wording is worse than showing it.
 */
export function expandRecipe(body: string, ctx: ReviewRecipeContext): string {
  /* A line that is only about the card — its placeholders are `{card}` and
     `{cardUrl}` and nothing else — goes when there is no card. Left in, the
     shipped frame's `card   {card} {cardUrl}` row reached the agent as the
     bare word "card" and a gap, on every pull request without a tracker id.
     Lines that mix the card with anything else are the person's sentence and
     stay as written. With a card nothing here runs. */
  if (!ctx.card && !ctx.cardUrl) {
    body = body.split("\n").filter((line) => {
      const ph = line.match(/\{\w+\}/g);
      return !(ph && ph.every((p) => p === "{card}" || p === "{cardUrl}"));
    }).join("\n");
  }
  return body.replace(/\{(number|repo|head|branch|title|author|url|since|card|cardUrl|who|note|base|files|worktree)\}/g, (whole, key: string) => {
    const v = {
      number: ctx.number ? String(ctx.number) : "",
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
      base: ctx.base ?? "",
      files: ctx.files ?? "",
      worktree: ctx.worktree ?? "",
    }[key];
    return v === undefined ? whole : v;
  });
}
