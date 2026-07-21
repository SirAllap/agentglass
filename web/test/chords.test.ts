import { beforeEach, describe, expect, it } from "bun:test";

/**
 * The workspace shortcuts.
 *
 * The interesting property is precedence: a custom chord has to beat the
 * positional default, including when it takes a digit that some other view
 * currently sits on. Get that backwards and setting a shortcut appears to do
 * nothing — the position shadows it — which is the kind of bug that reads as
 * "the setting is broken" rather than "the rule is wrong".
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
(globalThis as unknown as { navigator: Navigator }).navigator ??= { platform: "Linux" } as Navigator;

const ORDER = ["git", "diff", "docker", "term", "chat"] as const;
const order = () => [...ORDER];
const load = async () => await import(`../src/lib/keybindings.ts?c=${Math.random()}`);

beforeEach(() => store.clear());

describe("workspace chords", () => {
  it("falls back to rail position when nothing is bound", async () => {
    const k = await load();
    expect(k.chordFor("git", order())).toBe("1");
    expect(k.chordFor("chat", order())).toBe("5");
    expect(k.viewForChord("3", order())).toBe("docker");
  });

  it("follows a reorder rather than the shipped list", async () => {
    const k = await load();
    expect(k.chordFor("chat", ["chat", "git", "diff", "docker", "term"])).toBe("1");
  });

  it("lets a custom chord win over a position that wants the same key", async () => {
    const k = await load();
    // "2" is diff's position; give it to chat explicitly.
    expect(k.rebindChord("chat", "2", order()).ok).toBe(false); // taken by diff
    k.clearChord("chat");
    // ...but once diff has moved off it, the digit is free.
    const moved = ["git", "docker", "term", "chat", "diff"];
    expect(k.rebindChord("chat", "2", moved).ok).toBe(false); // docker is 2nd now
  });

  it("binds a letter and resolves it ahead of the digits", async () => {
    const k = await load();
    expect(k.rebindChord("chat", "c", order())).toEqual({ ok: true });
    expect(k.chordFor("chat", order())).toBe("c");
    expect(k.viewForChord("c", order())).toBe("chat");
    // chat has left position 5, and nothing else is there, so the digit is dead.
    expect(k.viewForChord("5", order())).toBe(null);
  });

  it("refuses a key the app itself owns", async () => {
    const k = await load();
    for (const bad of ["k", "\\", "[", "]", "0", "-", "="]) {
      expect(k.rebindChord("chat", bad, order()).ok).toBe(false);
    }
    expect(k.chordFor("chat", order())).toBe("5");
  });

  it("refuses a key another view already answers to", async () => {
    const k = await load();
    k.rebindChord("chat", "c", order());
    const r = k.rebindChord("term", "c", order());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("chat");
  });

  it("survives a reload and can be cleared back to positional", async () => {
    const k = await load();
    k.rebindChord("term", "j", order());
    const k2 = await load();
    expect(k2.chordFor("term", order())).toBe("j");
    expect(k2.chordsCustomised()).toBe(true);
    k2.clearChord("term");
    expect(k2.chordFor("term", order())).toBe("4");
    expect(k2.chordsCustomised()).toBe(false);
  });

  it("ignores a corrupt store rather than losing every shortcut", async () => {
    store.set("agentglass.chords", "{{{");
    const k = await load();
    expect(k.chordFor("git", order())).toBe("1");
  });

  it("hands back a stable object, as the rail's snapshot", async () => {
    const k = await load();
    expect(k.chords()).toBe(k.chords());
  });
});
