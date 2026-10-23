/*
 * A Jira card's GitHub tab lists the pull requests its own words mention, not
 * only the ones written as remote links, so the card is found from any
 * project's window. Pure: the text is what the card read already carried.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prMentions } from "../../shared/taskref.ts";
import { mentionsOfCard, withMentions, MENTION_CAP } from "../src/lib/jiraLinks.ts";
import { JiraPrsView } from "../src/components/jira/JiraCardPrs.tsx";

const PR = "https://github.com/acme/orbit/pull/2198";
const linked = { url: PR, number: 2198, title: "acme/orbit#2198: Retry", resolved: false };

describe("prMentions", () => {
  test("finds a bare address, a markdown link and one in a sentence, canonical", () => {
    const text = `Pull request: ${PR}/files#diff.\nsee [it](https://GitHub.com/Acme/Orbit/pull/7?x=1) and (https://gitlab.com/acme/orbit/-/merge_requests/41).`;
    expect(prMentions(text).map((p) => p.url)).toEqual([
      PR, "https://github.com/acme/orbit/pull/7", "https://gitlab.com/acme/orbit/-/merge_requests/41",
    ]);
  });
  test("lookalike hosts, other pages and plain text are ignored", () => {
    const text = [
      "https://github.com.evil.example/acme/orbit/pull/1",
      "https://github.com@evil.example/acme/orbit/pull/2",
      "http://github.com/acme/orbit/pull/3",
      "https://github.com/acme/orbit/issues/4",
      "https://example.com/acme/orbit/pull/5",
      "orbit#6 and pull/7",
    ].join("\n");
    expect(prMentions(text)).toEqual([]);
  });
  test("one address written twice is one", () => {
    expect(prMentions(`${PR} and ${PR}/ and ${PR.toUpperCase().replace("HTTPS", "https")}`).length).toBe(1);
  });
});

describe("withMentions", () => {
  const card = { description: "Fixes it. See " + PR, comments: [{ text: "also https://github.com/acme/orbit/pull/9" }] };
  test("a mention only in a comment is listed as such", () => {
    const m = mentionsOfCard({ description: "", comments: [{ text: `Pull request: ${PR}` }] });
    expect(withMentions([], m)).toEqual([{ url: PR, number: 2198, title: "acme/orbit#2198", resolved: false, where: "comment" }]);
  });
  test("the same address as a remote link lists once, as linked", () => {
    const out = withMentions([linked], mentionsOfCard(card));
    expect(out.filter((l) => l.url === PR).length).toBe(1);
    expect(out.find((l) => l.url === PR)!.where).toBe("link");
    expect(out.find((l) => l.number === 9)!.where).toBe("comment");
  });
  test("the description wins over a comment for the same address", () => {
    expect(withMentions([], mentionsOfCard({ description: PR, comments: [{ text: PR }] }))[0]!.where).toBe("description");
  });
  test("the cap holds", () => {
    const text = Array.from({ length: 40 }, (_, i) => `https://github.com/acme/orbit/pull/${i + 1}`).join("\n");
    expect(withMentions([], mentionsOfCard({ description: "", comments: [{ text }] })).length).toBe(MENTION_CAP);
  });
  test("a remote link is kept first even when mentions fill the cap", () => {
    const text = Array.from({ length: 40 }, (_, i) => `https://github.com/acme/orbit/pull/${i + 100}`).join("\n");
    const out = withMentions([linked], mentionsOfCard({ description: "", comments: [{ text }] }));
    expect(out[0]).toEqual({ ...linked, where: "link" });
    expect(out.length).toBe(MENTION_CAP);
  });
});

describe("the GitHub tab", () => {
  const rows = withMentions([linked], mentionsOfCard({ description: "", comments: [{ text: "https://github.com/acme/orbit/pull/9" }] }));
  const html = renderToStaticMarkup(React.createElement(JiraPrsView, { links: rows, error: "", writable: false, said: "", busy: false, draft: "", onDraft() {}, onLink() {} }));
  test("both kinds are drawn with their labels", () => {
    expect(html).toContain("#2198");
    expect(html).toContain("#9");
    expect(html).toContain("linked on the card");
    expect(html).toContain("mentioned in a comment");
  });
});
