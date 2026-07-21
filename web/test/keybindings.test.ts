import { beforeEach, describe, expect, it } from "bun:test";

/**
 * The bindings store, exercised through a stand-in localStorage.
 *
 * The rules worth pinning down are the ones that stop the keyboard becoming
 * unusable: a key belongs to exactly one action, the escape hatches cannot be
 * taken, and an action always has a key even if the stored map predates it.
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

const load = async () => {
  // Fresh module per test: the store caches, which is the point of it.
  const mod = await import(`../src/lib/keybindings.ts?t=${Math.random()}`);
  return mod as typeof import("../src/lib/keybindings.ts");
};

beforeEach(() => store.clear());

describe("keybindings", () => {
  it("starts on the shipped defaults", async () => {
    const kb = await load();
    expect(kb.bindings()["view.term"]).toBe("t");
    expect(kb.bindings()["open.stats"]).toBe("s");
    expect(kb.isCustomised()).toBe(false);
  });

  it("resolves a key to its action", async () => {
    const kb = await load();
    expect(kb.actionFor("g")).toBe("view.git");
    expect(kb.actionFor("¬")).toBe(null);
  });

  it("rebinds, and the new key resolves", async () => {
    const kb = await load();
    expect(kb.rebind("view.term", "y")).toEqual({ ok: true });
    expect(kb.actionFor("y")).toBe("view.term");
    expect(kb.actionFor("t")).toBe(null);
    expect(kb.isCustomised()).toBe(true);
  });

  it("refuses a key another action already holds, rather than stealing it", async () => {
    const kb = await load();
    const r = kb.rebind("view.term", "g");
    expect(r.ok).toBe(false);
    // Silently unbinding the other one leaves a shortcut that stopped working
    // with nothing to say why.
    expect(kb.actionFor("g")).toBe("view.git");
  });

  it("refuses the keys that are the way out of a mistake", async () => {
    const kb = await load();
    for (const k of ["Escape", "Enter", "Tab", "1"]) {
      expect(kb.rebind("view.term", k).ok).toBe(false);
    }
    expect(kb.actionFor("t")).toBe("view.term");
  });

  it("gives a new action its default even when the stored map predates it", async () => {
    store.set("agentglass.keybindings", JSON.stringify({ "view.git": "q" }));
    const kb = await load();
    expect(kb.bindings()["view.git"]).toBe("q");      // the stored choice stands
    expect(kb.bindings()["open.search"]).toBe("/");   // and the rest are not lost
  });

  it("ignores a corrupt stored map instead of throwing", async () => {
    store.set("agentglass.keybindings", "{not json");
    const kb = await load();
    expect(kb.bindings()["view.term"]).toBe("t");
  });

  it("reset puts every default back", async () => {
    const kb = await load();
    kb.rebind("view.term", "y");
    kb.resetBindings();
    expect(kb.bindings()["view.term"]).toBe("t");
    expect(kb.isCustomised()).toBe(false);
  });
});
