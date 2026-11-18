/* Sync with Jira filters ON but "No saved boards or filters yet": a run cancelled half way saved filters and never told the sidebar to reload. */
import { describe, expect, test } from "bun:test";
import { importFavourites } from "../src/lib/jiraFavourites.ts";

describe("importing starred Jira filters", () => {
  test("saves the ones not saved yet and reports how many", async () => {
    const saved: string[] = [];
    const n = await importFavourites([{ id: "1" }, { id: "2" }, { id: "3" }], new Set(["filter:2"]), new AbortController().signal, async (id) => { saved.push(id); return { ok: true }; });
    expect(n).toBe(2);
    expect(saved).toEqual(["1", "3"]);
  });
  test("a run cancelled half way still reports what it saved, so the list reloads", async () => {
    const ac = new AbortController();
    const n = await importFavourites([{ id: "1" }, { id: "2" }], new Set(), ac.signal, async () => { ac.abort(); return { ok: true }; });
    expect(n).toBe(1);
  });
  test("the hook reloads the list for those, even when it was cancelled", async () => {
    const src = await Bun.file(new URL("../src/lib/jiraFavourites.ts", import.meta.url)).text();
    expect(src).toContain("if (added) done.current();");
    expect(src).not.toContain("if (added && !gone.signal.aborted)");
  });
});
