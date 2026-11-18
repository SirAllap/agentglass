/*
 * JiraSearch's placeholder says "Enter searches Jira", but the merge that
 * rewrote this box's onKeyDown dropped the Enter handler. Typing a query and
 * pressing Enter did nothing: the key fell through every branch unhandled.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/jira/list/JiraSearch.tsx", import.meta.url)).text();

describe("JiraSearch's Enter key", () => {
  it("submits the query to the site, outside the JQL help popover", () => {
    expect(src).toMatch(/if \(e\.key === "Enter" && source && q\.trim\(\)\.length >= 2\) \{ e\.preventDefault\(\); submit\(\); return; \}/);
  });

  it("still lets the JQL help popover's own Enter pick a candidate first", () => {
    const keyDown = src.slice(src.indexOf("onKeyDown={(e)"), src.indexOf("className=\"flex-1 min-w-0"));
    const helpEnter = keyDown.indexOf('e.key === "Tab" || e.key === "Enter"');
    const submitEnter = keyDown.indexOf('e.key === "Enter" && source');
    expect(helpEnter).toBeGreaterThan(-1);
    expect(submitEnter).toBeGreaterThan(helpEnter);
  });
});

describe("JiraSearch's click", () => {
  it("opens the jump palette directly instead of focusing the box to type", () => {
    expect(src).toContain('onMouseDown={(e) => { e.preventDefault(); openJiraJump(); }}');
    expect(src).toContain('import { openJiraJump } from "../../../lib/jiraQueryPalette.ts";');
  });
});
