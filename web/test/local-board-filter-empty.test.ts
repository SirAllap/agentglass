/*
 * The Local board: a search that matches nothing, or pressing `e` on a task
 * (the bar then holds the task's own line), replaced the whole board — bar and
 * filters included — with "Nothing open", and Esc could not bring it back.
 * The empty state is for an empty list, not an empty filter. Read as source.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const body = src.slice(src.indexOf("const { open, done, counts } = useMemo("));

describe("the Local board's empty state", () => {
  it("is decided on the whole list, not the filtered one", () => {
    expect(body).toContain('!data.tasks.length ? "empty"');
    expect(body).toContain('(showDone ? !done.length : !open.length) ? (filtered ? "nomatch" : "idle")');
    expect(body).not.toContain("if (!open.length && !done.length) return <LocalState");
  });

  it("does not treat the bar as a search while a task is being edited", () => {
    expect(body).toContain('const q = editing ? "" :');
  });

  it("keeps the bar and the filter chips when a filter matches nothing, and says how to get back", () => {
    const i = src.indexOf("function LocalState(");
    const empty = src.slice(i, src.indexOf("\nfunction LocalBody"));
    expect(empty).toContain("No task matches");
    expect(empty).toContain("The bar and filters stay where they are. Clear them to see everything.");
    expect(empty).toContain("Clear filters");
    // Decided inside the list area, under the bar and the chips, never instead of them.
    expect(body).toContain("onClear={clearFilters}");
    expect(body.indexOf("placeholder={editing")).toBeLessThan(body.indexOf("<LocalState view={view}"));
  });

  it("clears the search, the project/tag, the priority and the date pill", () => {
    const i = body.indexOf("const clearFilters");
    expect(i).not.toBe(-1);
    const f = body.slice(i, body.indexOf("};", i));
    for (const s of ["setInput(\"\")", "setFilter(null)", "setPrio(null)", "setBucket(null)", "setEditing(null)"]) expect(f).toContain(s);
  });
});
