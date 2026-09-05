// "Quote reply", as GitHub's comment menu does it.
//
// What it puts in the box is markdown, not the rendered paragraph — a quote whose
// backticks and headings were flattened is a quote that says something slightly
// different from what was said, which is the one thing a quote may not do.
//
// Appended rather than replacing, because the quote is usually the SECOND thing in a
// reply that was already half written; and the composer's own stash is where it goes,
// so a quote you have not sent yet survives leaving the pull request exactly as a
// half-typed sentence already does.

/**
 * The composer's new contents: what was already there, then the quote, then a blank
 * line for the answer.
 *
 * Every line is prefixed, including the empty ones — a blank line inside a quote
 * with no `>` on it ends the quote, so half of a two-paragraph remark would come out
 * as the reply's own prose.
 */
export function quoteReply(had: string, body: string): string {
  /* Guarded on the BODY, not on the quote built from it: a body of nothing but
     whitespace becomes a single ">" once every line is prefixed, and ">" is truthy —
     so the composer would gain an empty quote marker for a remark with nothing in
     it. Caught by the suite, not by reading. */
  if (!body.trim()) return had;
  const quoted = body.replace(/\s+$/, "").split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
  const before = had.replace(/\s+$/, "");
  return `${before ? `${before}\n\n` : ""}${quoted}\n\n`;
}
