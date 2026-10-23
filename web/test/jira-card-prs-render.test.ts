/*
 * The card pane's pull request section, drawn: the rows, the box only when the
 * write switch is on, and a sentence saying why when it is off.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JiraPrsView, LINKING_OFF } from "../src/components/jira/JiraCardPrs.tsx";

const links = [
  { url: "https://github.com/acme/orbit/pull/7", number: 7, title: "acme/orbit#7: Retry the export", resolved: false },
  { url: "https://github.com/acme/orbit/pull/9", number: 9, title: "acme/orbit#9", resolved: false },
];
const view = (o: Partial<Parameters<typeof JiraPrsView>[0]>) =>
  renderToStaticMarkup(React.createElement(JiraPrsView, { links, error: "", writable: false, said: "", busy: false, draft: "", onDraft() {}, onLink() {}, ...o }));

describe("JiraPrsView", () => {
  test("lists every pull request on the card", () => {
    const html = view({});
    expect(html).toContain("#7");
    expect(html).toContain("#9");
    expect(html).toContain("Retry the export");
  });

  test("with writes off there is no box, and one sentence says why", () => {
    const html = view({ writable: false });
    expect(html).not.toContain("<input");
    expect(html).toContain("switched off");
    expect(html).toContain(LINKING_OFF);
  });

  test("with writes on there is the box and no apology", () => {
    const html = view({ writable: true });
    expect(html).toContain("<input");
    expect(html).not.toContain("switched off");
  });

  test("a read that failed says so instead of claiming the card has none", () => {
    const html = view({ links: [], error: "Jira did not answer" });
    expect(html).toContain("Jira did not answer");
    expect(html).not.toContain("No pull request is linked");
  });
});
