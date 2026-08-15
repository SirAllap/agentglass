import { describe, expect, it } from "bun:test";

/*
 * A list is read through the view it opens on, not through the list endpoint.
 *
 * Measured on a real list, and the two answers are
 * different lists of tasks, not two orderings of one:
 *
 *   through the view : 105 tasks, and the multi-list card is in it
 *   through the list : 108 tasks, and it is not
 *
 * That card's home is another list and it appears in this one through ClickUp's
 * "Tasks in Multiple Lists". `/list/{id}/task` only ever returns the tasks
 * whose HOME is that list, so no amount of paging would have found it — and 63
 * of the view's 105 have another list as their home. The view also carries the
 * filter and the sort the person is looking at.
 *
 * Asserted on the source: the alternative is a live workspace in the suite, and
 * what has to hold is the ORDER of the two attempts and the fallback between
 * them.
 */
const src = await Bun.file(new URL("../src/providers.ts", import.meta.url)).text();
const clickup = await Bun.file(new URL("../src/clickup.ts", import.meta.url)).text();

const listReader = (() => {
  const at = src.indexOf("async function listTasksOf");
  return src.slice(at, src.indexOf("\n}", at));
})();

describe("reading a saved list", () => {
  it("asks the list's default view first", () => {
    expect(listReader).toContain("defaultViewOf(token, listId)");
    expect(listReader).toContain("viewTasks(token, viewId");
  });

  it("falls back to the raw list when there is no view to use", () => {
    // An older workspace, or a permission: the old behaviour is still better
    // than an empty board.
    expect(listReader).toContain("rawListTasks(token, listId, me)");
    // …but only on a failure. An empty view is a real answer — a list can be
    // empty — and retrying it as a raw list would put the multi-list cards back
    // out of reach.
    expect(listReader).toContain("if (r.ok) return r;");
  });

  it("does not cache a failed lookup as 'this list has no view'", () => {
    /* Caching the null would send every later read down the fallback for the
       rest of the session, which is the same bug wearing a hat. */
    const at = clickup.indexOf("export async function defaultViewOf");
    expect(clickup.slice(at, at + 900)).toContain("if (r.ok) listViewCache.set");
  });
});

describe("when the view answers nothing", () => {
  it("checks the list before believing it", () => {
    /*
     * Measured on two real lists: one answers 105 tasks through its default
     * view, and another — a hundred cards, twelve of them on screen in the
     * browser — answers ZERO through its own while its other views answer
     * thirty each. A board that draws "nothing here" over a hundred cards is
     * the worst answer available, so an empty view is checked rather than
     * trusted.
     */
    const src = require("node:fs").readFileSync(new URL("../src/providers.ts", import.meta.url), "utf8") as string;
    const at = src.indexOf("async function listTasksOf");
    const fn = src.slice(at, src.indexOf("\n}", at));
    expect(fn).toContain("(r.data?.tasks.length ?? 0) > 0");
    expect(fn).toContain("const raw = await rawListTasks(token, listId, me);");
  });
});

describe("a list's own views, opened from the sidebar", () => {
  const src = require("node:fs").readFileSync(new URL("../src/providers.ts", import.meta.url), "utf8") as string;

  it("can be read without being saved", () => {
    /* They hang under a list in the rail and come and go with it. Refusing them
       is a row that opens nothing; saving them on first click would fill
       somebody's sidebar with every tab they ever glanced at. */
    expect(src).toContain("export function rememberListViews");
    const at = src.indexOf("export async function readView");
    expect(src.slice(at, at + 1600)).toContain("ephemeralViews.get(viewId)");
  });

  it("only for ids the server itself offered", () => {
    // The id reaches a board read. It has to be one we handed out, not any
    // string a caller sends.
    const idx = require("node:fs").readFileSync(new URL("../src/index.ts", import.meta.url), "utf8") as string;
    const at = idx.indexOf('pathname === "/clickup/list-views"');
    expect(idx.slice(at, at + 700)).toContain("rememberListViews(listId,");
  });

  it("keeps them out of the file", () => {
    // Memory only: the file holds what somebody chose to keep.
    expect(src).toContain("const ephemeralViews = new Map<string, string>();");
    expect(src).not.toContain("addView({ id: viewId");
  });
});
