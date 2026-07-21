import { beforeEach, describe, expect, it } from "bun:test";

/**
 * The rail's order, and specifically the property that broke the app.
 *
 * `loadViewOrder` is the getSnapshot for a `useSyncExternalStore`, which
 * compares snapshots by IDENTITY. A function that builds a fresh array each
 * call therefore reports a change on every render, React re-renders, and it
 * loops until it gives up and paints nothing — a blank workspace seconds after
 * a drag. Nothing in tsc or the type system can see that; only an identity
 * assertion can.
 */
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

const load = async () => await import(`../src/components/workspace/views.ts?t=${Math.random()}`);

beforeEach(() => store.clear());

describe("view order", () => {
  it("returns the same array instance until something changes it", async () => {
    const v = await load();
    expect(v.loadViewOrder()).toBe(v.loadViewOrder());
  });

  it("still returns a stable instance after a reorder", async () => {
    const v = await load();
    v.saveViewOrder(["term", "git", "diff", "docker", "chat"]);
    const first = v.loadViewOrder();
    expect(v.loadViewOrder()).toBe(first);
    expect(first.map((x: { id: string }) => x.id)[0]).toBe("term");
  });

  it("keeps a view the saved order has never heard of", async () => {
    // An order saved by an older version must not silently drop whatever was
    // added since — the view would vanish from the rail with no way back.
    store.set("agentglass.workspace.order", JSON.stringify(["chat", "git"]));
    const v = await load();
    const ids = v.loadViewOrder().map((x: { id: string }) => x.id);
    expect(ids.slice(0, 2)).toEqual(["chat", "git"]);
    expect(ids).toContain("term");
    expect(ids).toContain("docker");
    expect(ids).toContain("diff");
    expect(ids.length).toBe(5);
  });

  it("ignores a corrupt saved order rather than throwing", async () => {
    store.set("agentglass.workspace.order", "{not json");
    const v = await load();
    expect(v.loadViewOrder().length).toBe(5);
  });

  it("drops an id that no longer exists", async () => {
    store.set("agentglass.workspace.order", JSON.stringify(["ghost", "term"]));
    const v = await load();
    const ids = v.loadViewOrder().map((x: { id: string }) => x.id);
    expect(ids).not.toContain("ghost");
    expect(ids[0]).toBe("term");
  });
});
