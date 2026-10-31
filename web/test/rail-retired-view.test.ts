/*
 * A rail layout saved while the Files view existed names it in a drawer. The
 * view is gone, so the layout must still load: the unknown id is skipped and
 * every other view keeps its place, with nothing left to crash the workspace.
 */
import { describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal";
const stubGlobal = globalStubs();

const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));

describe("a saved rail that still names the retired Files view", () => {
  it("loads without it, and keeps the other views where they were", async () => {
    store.set("agentglass.workspace.rail", JSON.stringify({
      work: ["term", "files", "git"], utility: ["files", "docker"], hidden: ["pr"],
    }));
    // A fresh copy: views.ts caches the rail it built, and another file in this process may have built one first.
    const v = await import(`../src/components/workspace/views.ts?t=${Math.random()}`);
    const ids = v.railIds(v.loadRail());
    expect(ids.work.slice(0, 2)).toEqual(["term", "git"]);
    expect(ids.utility[0]).toBe("docker");
    expect(ids.hidden).toContain("pr");
    for (const place of v.RAIL_PLACES) expect(ids[place] as string[]).not.toContain("files");
  });
});
