import { beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal";
const stubGlobal = globalStubs();

// The Skills catalog is an optional rail item like Manifest: in the registry,
// hidden on a fresh install, and shown/moved through the same saved layout.
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

const load = async () => await import(`../src/components/workspace/views.ts?t=${Math.random()}`);
const ids = (list: { id: string }[]) => list.map((x) => x.id);

beforeEach(() => store.clear());

describe("skills on the rail", () => {
  it("is in the registry as a modal view", async () => {
    const v = await load();
    expect(v.isViewId("skills")).toBe(true);
    expect(v.VIEWS.find((x: { id: string }) => x.id === "skills")?.modal).toBe(true);
  });

  it("is hidden by default", async () => {
    const v = await load();
    expect(ids(v.loadRail().hidden)).toContain("skills");
  });

  it("can be shown and moved by the order setting", async () => {
    const v = await load();
    v.moveView("skills", "utility", 0);
    expect(ids(v.loadRail().utility)[0]).toBe("skills");
    expect(v.railCustomised()).toBe(true);
  });

  it("accepts a saved layout that names it, and keeps it there", async () => {
    store.set("agentglass.workspace.rail", JSON.stringify({ work: ["term", "skills", "git"], utility: [], hidden: [] }));
    const v = await load();
    expect(ids(v.loadRail().work).slice(0, 3)).toEqual(["term", "skills", "git"]);
    expect(ids(v.loadRail().hidden)).not.toContain("skills");
  });
});
