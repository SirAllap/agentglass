/*
 * The rules of the Jira list's top rows (toolbar, search, chips, footer, the write popover): the decisions as pure
 * functions, and what the sources must not do, asserted against the source text since there is no renderer.
 */
import { describe, expect, test } from "bun:test";
import type { ListStatus, ProviderTask } from "../../shared/providers.ts";
import { NO_FILTERS, filterCards } from "../src/components/jira/list/model.ts";
import {
  breadcrumbOf, fetchOffered, footerCount, groupChoices, hitReason, showDoneLabel, siteSearchOffered, statusMenuOf, statusTrigger, thenChoices, togglePick, withGroup,
} from "../src/components/jira/list/toolbarModel.ts";
import { writesAsk, writesTitle, type BoardWrites } from "../src/components/tasks/WritesSwitch.tsx";

const st = (status: string, i: number, type: ListStatus["type"] = "open"): ListStatus => ({ status, type, orderindex: i });
const card = (id: string, status: string, o: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id, customId: `ORB-${id}`, title: `Card ${id}`, status, statusKind: "open", assignees: [], tags: [], ...o } as ProviderTask);

describe("the toolbar and the footer", () => {
  test("the breadcrumb draws what exists, nothing empty", () => {
    expect(breadcrumbOf({ space: "Acme", list: "Orbit" } as never)).toEqual(["Acme", "Orbit"]);
    expect(breadcrumbOf(undefined)).toEqual([]);
  });
  test("the footer count says when the read was cut short", () => {
    const c = { shown: 14, total: 19 } as never;
    expect(footerCount(c, false)).toBe("14 of 19");
    expect(footerCount(c, true)).toBe("14 of 19+");
  });
});

describe("the chips row", () => {
  const statuses = [st("To do", 0), st("In progress", 1), st("Done", 2, "done")];
  const cards = [card("1", "To do"), card("2", "To do"), card("3", "Done")];
  test("Status separates the finished ones and counts each", () => {
    const m = statusMenuOf(statuses, cards, ["To do"]);
    expect(m.working.map((r) => [r.status, r.count, r.on])).toEqual([["To do", 2, true], ["In progress", 0, false]]);
    expect(m.finished.map((r) => r.status)).toEqual(["Done"]);
  });
  test("a pick toggles, and the trigger says how many", () => {
    expect(togglePick(["a"], "b")).toEqual(["a", "b"]);
    expect(togglePick(["a", "b"], "a")).toEqual(["b"]);
    expect(statusTrigger([])).toBe("Status");
    expect(statusTrigger(["a", "b"])).toBe("2 selected");
  });
  test("Show done names what it would do", () => {
    expect(showDoneLabel(false, 5)).toBe("Show 5 done");
    expect(showDoneLabel(true, 5)).toBe("Showing everything");
  });
  test("Group offers Area only on a board with epics; changing it resets Then", () => {
    expect(groupChoices(false).some((g) => g.value === "area")).toBe(false);
    expect(groupChoices(true).some((g) => g.value === "area")).toBe(true);
    expect(thenChoices("status", false).map((t) => t.value)).toEqual(["none"]);
    expect(withGroup("assignee" as never).thenGroup).toBe("none");
  });
  test("the epic's sprint scope keeps only that sprint's cards", () => {
    const cs = [card("1", "To do", { sprint: "Sprint 4" }), card("2", "To do", { sprint: "Sprint 3" }), card("3", "To do")];
    expect(filterCards(cs, { ...NO_FILTERS, sprintOnly: "Sprint 4" }).map((t) => t.id)).toEqual(["1"]);
    expect(filterCards(cs, { ...NO_FILTERS, sprintOnly: null }).length).toBe(3);
  });
});

describe("the search row", () => {
  test("the site is offered from two characters, never for a key", () => {
    expect(siteSearchOffered("a")).toBe(false);
    expect(siteSearchOffered("checkout")).toBe(true);
    expect(siteSearchOffered("ORB-12")).toBe(false);
  });
  test("a key not on the page is offered for fetching; one that is, is not", () => {
    expect(fetchOffered("ORB-77", [card("1", "To do")])).toBe("ORB-77");
    expect(fetchOffered("ORB-1", [card("1", "To do")])).toBeNull();
    expect(fetchOffered("checkout", [])).toBeNull();
  });
  test("a hit says whether it is the card or mentions it", () => {
    expect(hitReason(card("1", "x"), "orb-1")).toBe("the card");
    expect(hitReason(card("1", "x"), "checkout")).toBe("mentions it");
  });
});

describe("the write popover wording", () => {
  const w = (o: Partial<BoardWrites>): BoardWrites => ({ on: false, forced: false, tracker: "Jira", asking: false, ask: () => {}, set: async () => {}, ...o });
  test("off a board it does not name a tracker", () => {
    expect(writesTitle(null)).toBe("Open a board to change this");
  });
  test("ClickUp keeps its own variable, Jira never shows it", () => {
    expect(writesTitle(w({ on: true, forced: true, tracker: "ClickUp" }))).toContain("AGENTGLASS_CLICKUP_WRITE");
    expect(writesTitle(w({ on: true, forced: true, tracker: "Jira" }))).not.toContain("CLICKUP");
    expect(writesAsk("Jira")).not.toMatch(/workspace|ClickUp/);
    expect(writesAsk("ClickUp")).toContain("workspace");
  });
});

const dir = "../src/components/jira/list/";
const files = ["JiraToolbar", "JiraSearch", "JiraChips", "JiraFooter", "SearchSheet", "StatusMenu", "GroupControl", "FilterPanel", "ListControls", "MenuParts"];
const texts: Record<string, string> = {};
for (const f of files) texts[f] = await Bun.file(new URL(`${dir}${f}.tsx`, import.meta.url)).text();
const writesSrc = await Bun.file(new URL("../src/components/tasks/WritesSwitch.tsx", import.meta.url)).text();

describe("the sources", () => {
  const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  const text: Record<string, string> = {};
  for (const f of files) text[f] = strip(texts[f]);

  test("no native title: every tip is data-tip", () => {
    // TaskDialog's `title` is its heading prop, not an attribute of an element
    for (const f of files) expect(text[f].replaceAll("<TaskDialog title=", "")).not.toMatch(/\stitle=\{|\stitle="/);
  });
  test("a control that only draws an icon has a label and the tooltip", () => {
    const body = text.ListControls;
    const iconBtn = body.slice(body.indexOf("export function ListIconBtn("), body.indexOf("export function IconLink("));
    expect(iconBtn).toContain("aria-label={label}");
    expect(iconBtn).toContain("data-tip=");
  });
  test("the search field is 32 high and its Escape clears before anything closes", () => {
    expect(text.JiraSearch).toContain("height: 32");
    expect(text.JiraSearch).toMatch(/Escape" && q\)/);
  });
  test("the results sheet drops a stale answer", () => {
    expect(text.SearchSheet).toContain("++ticket.current");
    expect(text.SearchSheet).toContain("run === ticket.current");
  });
  test("the footer is 32 high", () => {
    expect(text.JiraFooter).toContain("height: 32");
  });
  test("the write popover is the list view's 320 wide skin", () => {
    const w = writesSrc;
    expect(w).toContain("width: 320");
    expect(w).toContain("Allow changes to this board?");
  });
});
