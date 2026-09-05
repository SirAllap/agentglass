/*
 * `@somebody` in a review, and the one that is you.
 *
 * These arrived as plain text, so the single line in a page of review that is
 * addressed to a person read like the rest of the prose. On github.com your own
 * handle is highlighted, and that highlight is how you find that line.
 *
 * The risk in a rule like this is over-matching: `@` is in email addresses, in npm
 * scopes, in shell prose. Every case below that must NOT become a link is a case
 * this panel has on screen daily, and the bodies it runs on are untrusted text
 * written by anybody who can comment.
 */
import { describe, expect, it } from "bun:test";
import { renderInline } from "../src/lib/prBody.ts";

const md = (s: string, viewer?: string) => renderInline(s, "acme/orbit", viewer);

describe("a mention", () => {
  it("is a link to the person", () => {
    const html = md("thanks @javidoe");
    expect(html).toContain('href="https://github.com/javidoe"');
    expect(html).toContain(">@javidoe</a>");
    expect(html).toContain('class="agx-mention"');
  });

  it("is marked when it is you, and only then", () => {
    expect(md("thanks @javidoe", "javidoe")).toContain("agx-mention-you");
    expect(md("thanks @javidoe", "samlee")).not.toContain("agx-mention-you");
    // No viewer known yet: a link, and no claim about who it is for.
    expect(md("thanks @javidoe")).not.toContain("agx-mention-you");
  });

  it("does not care what case somebody typed", () => {
    expect(md("cc @JaviDoe", "javidoe")).toContain("agx-mention-you");
  });

  it("keeps the sentence around it", () => {
    const html = md("ok @javidoe, done.");
    expect(html).toContain("ok ");
    expect(html).toContain(", done.");
  });

  it("reads a team mention as the team it is", () => {
    const html = md("cc @acme/backend");
    expect(html).toContain('href="https://github.com/orgs/acme/teams/backend"');
    expect(html).toContain(">@acme/backend</a>");
  });

  it("survives a handle with hyphens in it", () => {
    expect(md("@sir-allap")).toContain(">@sir-allap</a>");
  });
});

describe("what is not a mention", () => {
  it("an email address", () => {
    const html = md("write to dev@example.com about it");
    expect(html).not.toContain("agx-mention");
  });

  it("something inside a code span — an npm scope, a decorator, a shell variable", () => {
    for (const src of ["`@types/node`", "`@property`", "`echo $USER@$HOST`"]) {
      expect(md(src)).not.toContain("agx-mention");
    }
  });

  it("a handle inside a link's text or its href", () => {
    const html = md("[see @javidoe](https://github.com/javidoe)");
    // The anchor the author wrote, and no mention anchor nested inside it.
    expect(html.match(/<a /g) ?? []).toHaveLength(1);
    expect(html).not.toContain("agx-mention");
  });

  it("a bare `@` with nothing after it", () => {
    expect(md("what @ even is this")).not.toContain("agx-mention");
  });

  // A login is 39 characters at most. Anything longer is not a person and a link to
  // it would 404 — which looks answerable and is not.
  it("a run far longer than any GitHub login", () => {
    const html = md("@" + "a".repeat(60));
    expect(html).toContain("agx-mention");
    // Matched up to the 39 GitHub allows, and the rest is left as text.
    expect(html).toContain(">@" + "a".repeat(39) + "</a>");
  });

  it("and the text is still escaped on the way out", () => {
    const html = md('@javidoe <img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
