/*
 * The Jira card's Activity, as data and as drawn: what each tab holds, which
 * ones may ask the site for the history, and that newest first is the same
 * list turned around.
 *
 * What a mistake costs: a Comments tab that costs a history request, a "newest
 * first" that turns the rows but not the run inside them (so the last thing
 * that happened is the second line), or a comment that vanishes from All.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { allRows, commentsFor, eventsFor, needsHistory, orderRows } from "../src/lib/jiraActivityRows.ts";
import { activityRows, eventLine } from "../src/lib/cardActivity.ts";
import { EventRun } from "../src/components/CardEventRun.tsx";
import type { CardEvent } from "../../shared/providers.ts";

const ev = (at: number, kind: "change" | "worklog", text: string, who = "Ada Example"): CardEvent => ({ at, kind, who, text });
const cm = (id: string, at: number) => ({ id, who: "Grace Sample", text: `note ${id}`, at });

describe("which tab may ask for the history", () => {
  test("History and All do; Comments and Work log never", () => {
    expect([needsHistory("history"), needsHistory("all"), needsHistory("comments"), needsHistory("worklog")]).toEqual([true, true, false, false]);
  });
});

describe("the tabs hold one kind each, and All holds the three by time", () => {
  const history = [ev(30, "change", "assigned this to Grace Sample"), ev(10, "change", 'changed the Status from "To Do" to "In Progress"')];
  const worklog = [ev(20, "worklog", "logged 45m")];
  test("history and work log are separate, oldest first", () => {
    expect(eventsFor("history", history, worklog).map((e) => e.at)).toEqual([10, 30]);
    expect(eventsFor("worklog", history, worklog).map((e) => e.at)).toEqual([20]);
  });
  test("All is the comments with the runs of what happened between them", () => {
    const rows = allRows([cm("a", 15), cm("b", 40)], history, worklog, false);
    expect(rows.map((r) => (r.kind === "comment" ? `c:${r.comment.id}` : `e:${r.events.map((e) => e.at).join("+")}`))).toEqual(["e:10", "c:a", "e:20+30", "c:b"]);
  });
  test("a comment is never lost from All", () => {
    expect(allRows([cm("a", 15)], [], [], false).filter((r) => r.kind === "comment").length).toBe(1);
  });
});

describe("newest first is the same list turned around", () => {
  test("rows are reversed and so is the run inside each row", () => {
    const rows = allRows([cm("a", 15)], [ev(10, "change", "x"), ev(12, "change", "y"), ev(20, "change", "z"), ev(22, "change", "w")], [], true);
    expect(rows.map((r) => (r.kind === "comment" ? "c" : r.events.map((e) => e.at).join("+")))).toEqual(["22+20", "c", "12+10"]);
  });
  test("oldest first leaves the rows as they were built, and turning twice is the original", () => {
    const base = activityRows([cm("a", 15)], [ev(10, "change", "x"), ev(20, "change", "z")]);
    expect(orderRows(base, false)).toBe(base);
    expect(orderRows(orderRows(base, true), true).map((r) => r.at)).toEqual(base.map((r) => r.at));
  });
  test("comments alone, both ways", () => {
    expect(commentsFor([cm("b", 2), cm("a", 1)], false).map((c) => c.id)).toEqual(["a", "b"]);
    expect(commentsFor([cm("b", 2), cm("a", 1)], true).map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("a Jira row is drawn with its person", () => {
  test("the sentence names who, and the run is never folded in a tab of its own", () => {
    expect(eventLine(ev(1, "worklog", "logged 45m"))).toBe("Ada Example logged 45m");
    const events = [ev(1, "change", "set the Priority to \"High\""), ev(2, "change", "added the label bug"), ev(3, "change", "attached trace.png")];
    const flat = renderToStaticMarkup(React.createElement(EventRun, { events, open: false, onToggle() {}, flat: true }));
    expect(flat).toContain("<b>Ada Example</b>");
    for (const w of ["added the label bug", "attached trace.png"]) expect(flat).toContain(w);
    expect(flat).not.toContain("Show 3 changes");
    const folded = renderToStaticMarkup(React.createElement(EventRun, { events, open: false, onToggle() {} }));
    expect(folded).toContain("Show 3 changes");
    expect(folded).not.toContain("attached trace.png");
  });
});

describe("the Activity as first drawn", () => {
  const draw = async (props: Record<string, unknown>) => {
    const { JiraActivity } = await import("../src/components/jira/JiraActivity.tsx");
    return renderToStaticMarkup(React.createElement(JiraActivity, { cardKey: "ORBIT-1042", comments: [], moreComments: 0, onMoreComments() {}, worklog: [], worklogMore: 0, ...props } as never));
  };
  test("Jira's four tabs, Comments first, and an honest empty sentence", async () => {
    const html = await draw({});
    for (const w of ["All", "Comments", "History", "Work log", "Oldest first", "No comments yet."]) expect(html).toContain(w);
    expect(html.indexOf("All")).toBeLessThan(html.indexOf("History"));
    expect(html).toContain('aria-pressed="true"');
  });
  test("comments the card read left out are offered, with their number", async () => {
    expect(await draw({ moreComments: 3 })).toContain("Show 3 more comments");
    expect(await draw({ moreComments: 1 })).toContain("Show 1 more comment<");
  });
  test("the history is asked for only through the tab guard, never on a plain render", async () => {
    const src = (await Bun.file(new URL("../src/components/jira/JiraActivity.tsx", import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    expect((src.match(/api\.jiraActivity\(forKey, "history"/g) ?? []).length).toBe(1);
    expect(src).toContain("if (needsHistory(tab) && history.phase === \"idle\") void loadHistory(0);");
    const card = await Bun.file(new URL("../src/components/jira/JiraCard.tsx", import.meta.url)).text();
    expect(card).not.toContain("jiraActivity(");
  });
});
