// Batch 5 review: three findings on the no-rail centring and the toast's Open PR / Open card split button.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { noteSurfaceTip } from "../src/lib/linkRouter.ts";
import { onOpenCard, openCard, type CardJump } from "../src/lib/openCard.ts";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");

// A search for Activity + Flow & review: Activity counted one page and took the 720 px group; Flow mounted
// after its skeleton and took 1132 px; Activity never re-read, so the left edges differed by ~206 px.
// "Open in Tasks" on a card toast opened the card on the bench when the bench showed a board.
describe("a card toast's Open in Tasks", () => {
  test("asks for the Tasks view itself", () => {
    const got: CardJump[] = [];
    const off = onOpenCard((j) => got.push(j));
    openCard("ORBIT-1042", "ORBIT-1042", "jira", { view: true });
    openCard("ORBIT-1042");
    off();
    expect(got[0]!.view).toBe(true);
    expect(got[1]!.view).toBeUndefined();
  });
  test("the shell goes to the view on that request, not through the bench", () => {
    const app = src("App.tsx");
    expect(app).toContain('if (j.view) goView("tasks"); else toBoard("tasks");');
    expect(app).toContain('openCard(g.id, g.label, g.tracker, { view: where === "view" })');
  });
});

describe("the toast's Open PR / Open card button", () => {
  const toasts = src("components/NoteToasts.tsx");
  test("keyboard focus holds the toast, as the mouse does", () => {
    expect(toasts).toContain("if (held || focused || open || n.urgency === 2) return;");
    expect(toasts).toContain("onFocus={() => setFocused(true)}");
    expect(toasts).toContain("onBlur={() => setFocused(false)}");
  });
  test("its tip is the house tip, refreshed when the pointer or focus arrives", () => {
    expect(toasts).not.toContain('title={noteSurface(');
    expect(toasts).toContain("onMouseOver={(e) => { e.currentTarget.dataset.tip = noteSurfaceTip(");
    expect(toasts).toContain("onFocus={(e) => { e.currentTarget.dataset.tip = noteSurfaceTip(");
  });
  test("the tip says where a press goes for the setting it is given", () => {
    expect(noteSurfaceTip("pr", true, "Pull requests")).toBe("Opens on the bench");
    expect(noteSurfaceTip("pr", false, "Pull requests")).toBe("Opens in Pull requests");
    expect(noteSurfaceTip("card", true, "Tasks")).toBe("Opens on the bench");
  });
});
