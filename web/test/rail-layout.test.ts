import { beforeEach, describe, expect, it } from "bun:test";

/**
 * The rail's layout, and specifically the properties that broke the app.
 *
 * `loadRail` is the getSnapshot for a `useSyncExternalStore`, which compares
 * snapshots by IDENTITY. A function that builds a fresh object each call
 * therefore reports a change on every render, React re-renders, and it loops
 * until it gives up and paints nothing — a blank workspace seconds after a
 * drag. Nothing in tsc or the type system can see that; only an identity
 * assertion can.
 *
 * The rest is what the three drawers must never do to you: drop a view you
 * cannot get back, list one twice, or take the rail down with them when the
 * saved layout is corrupt.
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
// views.ts asks desktop.ts whether there is a browser view, and desktop.ts
// reaches api.ts, which reads `location` at module scope. Without this it
// throws half-initialised and every import here dies on a TDZ for HAS_BROWSER
// — which reads as "the rail is broken" rather than "the harness has no DOM".
(globalThis as unknown as { location: URL }).location ??= new URL("http://localhost:5173/");

const load = async () => await import(`../src/components/workspace/views.ts?t=${Math.random()}`);
const ids = (list: { id: string }[]) => list.map((x) => x.id);

beforeEach(() => store.clear());

describe("rail layout", () => {
  it("returns the same object until something changes it", async () => {
    const v = await load();
    expect(v.loadRail()).toBe(v.loadRail());
  });

  it("still returns a stable instance after a move", async () => {
    const v = await load();
    v.saveRail({ work: ["term", "git", "diff"], utility: ["dash"], hidden: [] });
    const first = v.loadRail();
    expect(v.loadRail()).toBe(first);
    expect(ids(first.work)[0]).toBe("term");
  });

  it("keeps a view the saved layout has never heard of, in its shipped drawer", async () => {
    // A layout saved by an older version must not silently drop whatever was
    // added since — the view would vanish from the rail with no way back.
    store.set("agentglass.workspace.rail", JSON.stringify({ work: ["term", "git"], utility: [], hidden: [] }));
    const v = await load();
    const r = v.loadRail();
    expect(ids(r.work).slice(0, 2)).toEqual(["term", "git"]);
    expect(ids(r.work)).toContain("diff");
    expect(ids(r.work)).toContain("pr");
    // dash and chat ship at the bottom, and that is where they turn up.
    expect(ids(r.utility)).toContain("dash");
    expect(ids(r.utility)).toContain("chat");
    // Never hidden: a view nobody has had the chance to reject should not
    // arrive already put away.
    expect(r.hidden).toEqual([]);
    // Against the module's own list, not a number: the point is that nothing is
    // dropped, and hardcoding a count means every view added later fails a test
    // about something else.
    expect(ids(r.work).length + ids(r.utility).length).toBe(v.VIEWS.length);
  });

  it("carries over a flat order from the old scheme, split by shipped drawer", async () => {
    // The layout key supersedes this one, but an order somebody already dragged
    // into shape still says which view they reach for first, and that survives.
    store.set("agentglass.workspace.order", JSON.stringify(["chat", "term", "git"]));
    const v = await load();
    const r = v.loadRail();
    expect(ids(r.work).slice(0, 2)).toEqual(["term", "git"]);
    expect(ids(r.utility)[0]).toBe("chat");
    expect(r.hidden).toEqual([]);
    expect(ids(r.work).length + ids(r.utility).length).toBe(v.VIEWS.length);
  });

  it("ignores a corrupt layout rather than throwing", async () => {
    store.set("agentglass.workspace.rail", "{not json");
    const v = await load();
    const r = v.loadRail();
    expect(ids(r.work).length + ids(r.utility).length + ids(r.hidden).length).toBe(v.VIEWS.length);
  });

  it("drops an id that no longer exists, and never lists one twice", async () => {
    // One claim per view across all three drawers: a layout naming `term` in
    // two of them would draw it once and count it twice, and the second copy
    // would be a tab that does nothing.
    store.set("agentglass.workspace.rail", JSON.stringify({
      work: ["ghost", "term", "term"], utility: ["term"], hidden: ["git"],
    }));
    const v = await load();
    const r = v.loadRail();
    const all = [...ids(r.work), ...ids(r.utility), ...ids(r.hidden)];
    expect(all).not.toContain("ghost");
    expect(ids(r.work)[0]).toBe("term");
    expect(all.length).toBe(new Set(all).size);
    expect(ids(r.hidden)).toEqual(["git"]);
  });

  it("numbers the top drawer and nothing else", async () => {
    const v = await load();
    // Every view named, because one left out is appended to its shipped drawer
    // — correct behaviour (see the test above), and it would quietly extend the
    // numbered list past what this test thinks it set up.
    const rest = v.VIEW_IDS.filter((id: string) => !["git", "diff", "term", "chat"].includes(id));
    v.saveRail({ work: ["git", "diff"], utility: ["term"], hidden: ["chat", ...rest] });
    expect(v.workIds()).toEqual(["git", "diff"]);
    expect(v.visibleIds()).toEqual(["git", "diff", "term"]);
    expect(v.isVisibleView("term")).toBe(true);
    expect(v.isVisibleView("chat")).toBe(false);
  });

  it("projects a move without writing one", async () => {
    // What a drag calls on every dragover. If it wrote, the rail would commit
    // the layout the pointer merely passed over on its way somewhere else.
    const v = await load();
    const base = { work: ["git", "diff", "pr"], utility: ["dash"], hidden: [] };
    const out = v.withMove(base, "pr", "utility", 0);
    expect(out.work).toEqual(["git", "diff"]);
    expect(out.utility).toEqual(["pr", "dash"]);
    expect(base.work).toEqual(["git", "diff", "pr"]);
    expect(store.get("agentglass.workspace.rail")).toBeUndefined();
  });

  it("does not reopen onto a view that has been hidden", async () => {
    // Landing where you left off is the point — but not on a tab the rail no
    // longer draws, which is a workspace with nothing selected.
    store.set("agentglass.workspace.rail", JSON.stringify({ work: ["diff"], utility: [], hidden: ["git"] }));
    store.set("agentglass.workspace.view", "git");
    const v = await load();
    expect(v.loadLastView()).toBe("diff");
  });

  it("knows when it has been rearranged, so the reset offers itself only then", async () => {
    const v = await load();
    expect(v.railCustomised()).toBe(false);
    v.moveView("term", "hidden");
    expect(v.railCustomised()).toBe(true);
    v.resetRail();
    expect(v.railCustomised()).toBe(false);
    expect(store.get("agentglass.workspace.rail")).toBeUndefined();
  });
});
