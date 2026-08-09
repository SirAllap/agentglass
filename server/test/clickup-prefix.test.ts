/*
 * What this workspace's card ids look like, derived rather than configured.
 *
 * Two callers depend on it and they fail in opposite directions, which is why
 * the empty case is asserted as loudly as the good one: the card finder uses it
 * to expand a bare `11040` into a real id, and the pull-request masthead uses
 * it to decide that `ABC-12` in a branch name is somebody ELSE's tracker. The
 * second must never act on an empty answer — "nothing read yet" is not "not
 * ours" — and the only way to keep that honest is to pin what empty means here.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSIGNED_VIEW_ID } from "../../shared/providers.ts";
import type { ProviderTask, SavedView } from "../../shared/providers.ts";

const V = await import("../src/clickupviews.ts");

const dir = mkdtempSync(join(tmpdir(), "agx-cuprefix-"));

beforeEach(() => { V.__setViewsPath(join(dir, `${Math.random().toString(36).slice(2)}.json`)); });
afterEach(() => { V.__setViewsPath(null); });

const view = (id: string): SavedView => ({ id, name: `view ${id}`, url: `https://clickup.com/v/l/${id}`, addedAt: 0 });

const card = (customId?: string): ProviderTask => ({
  id: "8ab12cd34", customId, title: "a card", url: "", status: "open", statusKind: "open",
  priority: null, due: null, updated: 0, tags: [], list: null, assignees: [], mine: false,
} as unknown as ProviderTask);

describe("the prefix this workspace's cards are numbered with", () => {
  it("is unknown until a board has actually been read", () => {
    V.addView(view("v1"));
    expect(V.knownCardPrefix()).toBe("");
  });

  it("is read off a card, hyphen and all", () => {
    V.addView(view("v1"));
    V.putCache({ view: view("v1"), tasks: [card("ORBIT-1042")], statuses: [], fields: [], at: 1 });
    expect(V.knownCardPrefix()).toBe("ORBIT-");
  });

  it("skips a board whose cards carry no human id", () => {
    // Custom ids are a workspace setting, so one board having them and another
    // not is ordinary. The first board that knows wins rather than the first
    // board there is.
    V.addView(view("v1"));
    V.addView(view("v2"));
    V.putCache({ view: view("v1"), tasks: [card(undefined)], statuses: [], fields: [], at: 1 });
    V.putCache({ view: view("v2"), tasks: [card("ORBIT-1042")], statuses: [], fields: [], at: 1 });
    expect(V.knownCardPrefix()).toBe("ORBIT-");
  });

  it("forgets it when the board it came from is removed", () => {
    V.addView(view("v1"));
    V.putCache({ view: view("v1"), tasks: [card("ORBIT-1042")], statuses: [], fields: [], at: 1 });
    V.removeView("v1");
    expect(V.knownCardPrefix()).toBe("");
  });
});

describe("which board already holds a card", () => {
  it("finds it by ClickUp's own id and by the human one", () => {
    // The two halves of the app hold different ids: a pull request carries
    // ORBIT-1042, a board's rows carry 8ab12cd34. Both have to land.
    V.addView(view("v1"));
    V.putCache({ view: view("v1"), tasks: [card("ORBIT-1042")], statuses: [], fields: [], at: 1 });
    expect(V.boardHolding("8ab12cd34")?.viewId).toBe("v1");
    expect(V.boardHolding("orbit-1042")?.viewId).toBe("v1");
    expect(V.boardHolding("ORBIT-9999")).toBe(null);
  });

  it("looks in the built-in board too, which is not in the stored list", () => {
    // "Assigned to me" is synthesised rather than saved, and it is a whole
    // workspace's worth of cards — the board most likely to be holding the one
    // being asked about. Reading the raw store walks straight past it.
    V.putCache({ view: { id: ASSIGNED_VIEW_ID, name: "Assigned to me", url: "", addedAt: 0, builtin: true },
      tasks: [card("ORBIT-1042")], statuses: [], fields: [], at: 1 });
    expect(V.boardHolding("ORBIT-1042")?.viewId).toBe(ASSIGNED_VIEW_ID);
    // And the same walk answers "what do this workspace's ids look like".
    expect(V.knownCardPrefix()).toBe("ORBIT-");
  });

  it("says nothing about a board whose cache is cold", () => {
    // Which the caller must read as "not that we know of" — showing the card as
    // a stray is the honest fallback, and it corrects itself once that board
    // has been opened.
    V.addView(view("v1"));
    expect(V.boardHolding("8ab12cd34")).toBe(null);
  });

  it("is not fooled by an empty question", () => {
    V.addView(view("v1"));
    V.putCache({ view: view("v1"), tasks: [card("ORBIT-1042")], statuses: [], fields: [], at: 1 });
    expect(V.boardHolding("")).toBe(null);
    expect(V.boardHolding("   ")).toBe(null);
  });
});

/*
 * The trap that produced ClickUp marks on repositories with no ClickUp.
 *
 * `savedViews()` always leads with the built-in board, which is right — nobody
 * should have to add "assigned to me" — and it means the list is never empty.
 * The pull-request masthead was asking `views.length > 0` as its "is ClickUp
 * set up here" test, so it got yes on a machine that has never held a token.
 *
 * Pinned as a property of this module rather than as a comment somewhere else,
 * because the next caller to reach for a count will reach for this one.
 */
describe("what the saved-view list can and cannot be asked", () => {
  it("is never empty, so its length is not a test for having ClickUp", () => {
    // No views added, no store on disk, no token anywhere.
    expect(V.savedViews().length).toBe(1);
    expect(V.savedViews()[0]!.id).toBe(ASSIGNED_VIEW_ID);
    expect(V.savedViews()[0]!.builtin).toBe(true);
  });

  it("still cannot be emptied by removing everything in it", () => {
    V.addView(view("v1"));
    V.removeView("v1");
    V.removeView(ASSIGNED_VIEW_ID);
    expect(V.savedViews().map((v) => v.id)).toEqual([ASSIGNED_VIEW_ID]);
  });
});

// The temp directory outlives the individual files each test wrote into it.
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* going away anyway */ } });
