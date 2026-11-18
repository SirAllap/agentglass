/*
 * Three things the JQL help got wrong after review: the highlighted row was never announced to a screen reader
 * (no aria-activedescendant, no option ids); a list dismissed with Escape stayed hidden after a click moved the
 * caret to another clause; and a parse error read on one view stayed under the box on another view with the
 * same text. Asserted against source, as there is no renderer here.
 */
import { expect, test } from "bun:test";

const search = await Bun.file(new URL("../src/components/jira/list/JiraSearch.tsx", import.meta.url)).text();
const popover = await Bun.file(new URL("../src/components/jira/list/JqlHelpPopover.tsx", import.meta.url)).text();
const list = await Bun.file(new URL("../src/lib/useJiraList.ts", import.meta.url)).text();

test("the box points a screen reader at the highlighted suggestion, and each suggestion has the id it points to", () => {
  expect(search).toContain("aria-activedescendant={showHelp ? `jql-help-${hot}` : undefined}");
  expect(popover).toContain("id={`jql-help-${i}`}");
});

test("a click in the box brings back a list Escape dismissed for another clause", () => {
  expect(search).toContain("onClick={(e) => { setDismissed(false); atCursor(e); }}");
});

test("a parse error is shown only for the view it was read on", () => {
  expect(list).toContain("setQueryError({ q: typed, at: scopeAt, text: r.error })");
  expect(list).toContain("queryError.q === typed && queryError.at === scopeAt");
});
