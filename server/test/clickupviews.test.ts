import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * The boards on the bar, one of which nobody added.
 *
 * "Assigned to me" is pinned rather than written into the file on first run,
 * and that distinction is the whole of this suite: a stored default is one
 * somebody can end up without — deleted once, gone forever, since it has no
 * address to paste back — while a pinned one cannot be lost and cannot drift
 * from what the code believes is there.
 */
const dir = mkdtempSync(join(tmpdir(), "agx-views-"));
const V = await import("../src/clickupviews.ts");
const { ASSIGNED_VIEW_ID } = await import("../../shared/providers.ts");

const board = (id: string) => ({ id, name: `Board ${id}`, url: `https://x.clickup.com/1/v/l/${id}`, addedAt: 1 });

beforeEach(() => {
  V.__setViewsPath(join(dir, "views.json"));
  V.__clear();
});
afterAll(() => {
  V.__setViewsPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("the board nobody has to add", () => {
  it("is there before anything has been added", () => {
    const [first, ...rest] = V.savedViews();
    expect(first?.id).toBe(ASSIGNED_VIEW_ID);
    expect(first?.builtin).toBe(true);
    expect(rest).toEqual([]);
  });

  it("stays first once real boards are added", () => {
    V.addView(board("6-1-1"));
    V.addView(board("6-2-1"));
    expect(V.savedViews().map((v) => v.id)).toEqual([ASSIGNED_VIEW_ID, "6-1-1", "6-2-1"]);
  });

  it("is never written to the file, so it cannot go stale or be edited into nonsense", () => {
    V.addView({ id: ASSIGNED_VIEW_ID, name: "whatever somebody typed", url: "", addedAt: 5 });
    // Selected, not stored.
    expect(V.currentView()).toBe(ASSIGNED_VIEW_ID);
    expect(V.savedViews().filter((v) => v.id === ASSIGNED_VIEW_ID).length).toBe(1);
    expect(V.savedViews()[0]!.name).not.toBe("whatever somebody typed");
  });

  it("cannot be removed", () => {
    V.removeView(ASSIGNED_VIEW_ID);
    expect(V.savedViews()[0]?.id).toBe(ASSIGNED_VIEW_ID);
  });

  it("can be the board you were last on", () => {
    // `setCurrent` checks the id is one we know about. Before this it only
    // knew the stored ones, so selecting the built-in board silently did
    // nothing and the panel reopened somewhere else.
    V.addView(board("6-1-1"));
    V.setCurrent(ASSIGNED_VIEW_ID);
    expect(V.currentView()).toBe(ASSIGNED_VIEW_ID);
  });

  it("still refuses an id nobody has", () => {
    V.addView(board("6-1-1"));
    V.setCurrent("6-9-9");
    expect(V.currentView()).toBe("6-1-1");
  });
});
