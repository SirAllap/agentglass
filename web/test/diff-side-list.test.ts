import { describe, expect, test } from "bun:test";
import type { ChangeRow } from "../../shared/types.ts";
import { dirOf, midTrunc, newestFirst, JUST_NOW_MS } from "../src/components/diff/SideFileList.tsx";

/* Two modes. The terminal side panel (embedded) is a plain, live, view-only list;
   the full Diff page keeps read ticks, "N read", Next unread, pills and times.
   There is no renderer here, so each mode is asserted against source. */
const page = await Bun.file(new URL("../src/components/diff/DiffPage.tsx", import.meta.url)).text();
const side = await Bun.file(new URL("../src/components/diff/SideFileList.tsx", import.meta.url)).text();
const row = (key: string, changedAt: number) => ({ key, path: `src/a/${key}.ts`, changedAt }) as ChangeRow;

describe("side panel list (embedded)", () => {
  test("one line per file, name cut with an ellipsis, no wrap, no read state, no pills, no times", () => {
    expect(side).toMatch(/truncate min-w-0/);
    for (const bad of ["overflowWrap", "whenLabel", "staged", "Mark as read", "reviewed", "unread"]) expect(side).not.toContain(bad);
  });
  test("newest change first, and a dot while it is fresh", () => {
    expect(newestFirst([row("old", 1), row("new", 9)]).map((r) => r.key)).toEqual(["new", "old"]);
    expect(side).toContain("data-just-now");
    expect(JUST_NOW_MS).toBe(60_000);
  });
  test("folder rows: middle-truncated path", () => {
    expect(dirOf("a/b/c.ts")).toBe("a/b");
    expect(midTrunc("short")).toBe("short");
    const long = "web/src/components/very/deep/folder/name/here";
    expect(midTrunc(long).length).toBeLessThanOrEqual(34);
    expect(midTrunc(long)).toContain("…");
  });
  test("the page uses it only when embedded, with no toolbar, no split, no n/space keys", () => {
    expect(page).toMatch(/embedded \? \(\s*<SideFileList/);
    expect(page).toMatch(/\{!narrow && <div className="shrink-0 flex flex-wrap items-center gap-1\.5/);
    expect(page).toMatch(/e\.key === "n" && !embedded/);
    expect(page).toMatch(/e\.key === " " && selected && !embedded/);
    expect(page).toMatch(/useState\(\(\) => \(embedded \? false : diffSplit\(\)\)\)/);
  });
  test("a narrow panel folds the list into a dropdown", () => {
    expect(page).toContain("EMBEDDED_LIST_FOLD_PX");
    expect(page).toMatch(/<select aria-label="Changed file"/);
  });
});

describe("full Diff page keeps everything", () => {
  test("read circle, counter, Next unread, staged pill and time are still in the page", () => {
    expect(page).toContain("Mark as read");
    expect(page).toContain("Next unread");
    expect(page).toMatch(/\{totals\.done\} read/);
    expect(page).toMatch(/r\.staged !== "none" && \(/);
    expect(page).toContain("whenLabel(r.changedAt)");
    expect(page).toMatch(/!embedded && <><span aria-hidden className="w-px/);
  });
});
