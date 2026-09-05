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

describe("a list board reads BOTH the view and the list", () => {
  it("merges them, because each is missing what the other has", () => {
    /*
     * The view answers the question on screen and reaches cards whose home is
     * another list — 63 of one real list's 105. What it also does is apply the
     * view's own FILTER, and a list's default view usually has one: measured
     * on that same list, the view answered 105 cards across nine statuses
     * while the list holds 252 across fourteen. Everything in TO DO, IN
     * STAGING, IN PRODUCTION, WON'T FIX and COMPLETED was invisible — not
     * collapsed, absent, with no way to ask for it.
     *
     * And the older reason this reads both is still here: one list answers
     * ZERO through its own default view while its other views answer thirty
     * each, and a board drawing "nothing here" over a hundred cards is the
     * worst answer available.
     */
    const src = require("node:fs").readFileSync(new URL("../src/providers.ts", import.meta.url), "utf8") as string;
    const at = src.indexOf("async function listTasksOf");
    const fn = src.slice(at, src.indexOf("\n}", at));
    expect(fn).toContain("const raw = await rawListTasks(token, listId, me);");
    expect(fn, "and both are kept, not one chosen").toContain("mergeById(");
  });

  it("and the raw half asks for the closed ones", () => {
    /* A status of type `closed` is still a status a person groups by.
       `include_closed=false` meant COMPLETED — 199 of that list's 252 — was
       never fetched, so the board could not have drawn the group however it
       was asked. Whether a done group is SHOWN is a separate decision the
       panel already makes. */
    const cu = require("node:fs").readFileSync(new URL("../src/clickup.ts", import.meta.url), "utf8") as string;
    const at = cu.indexOf("export async function rawListTasks");
    expect(cu.slice(at, cu.indexOf("\n}", at))).toContain("include_closed=true");
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
