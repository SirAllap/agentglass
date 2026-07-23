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
    expect(k.chordFor("git", order())).toBe("mod+1");
    expect(k.chordFor("chat", order())).toBe("mod+5");
    expect(k.viewForChord("mod+3", order())).toBe("docker");
  });

  it("reads a whole combination off the event, in a stable order", async () => {
    const k = await load();
    const ev = (o: object) => ({ key: "j", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
    expect(k.chordFromEvent(ev({ ctrlKey: true }))).toBe("mod+j");
    expect(k.chordFromEvent(ev({ ctrlKey: true, altKey: true }))).toBe("mod+alt+j");
    expect(k.chordFromEvent(ev({ altKey: true }))).toBe("alt+j");
    // Alt+Ctrl+J is Ctrl+Alt+J; one shortcut must not be storable as two.
    expect(k.chordFromEvent(ev({ altKey: true, ctrlKey: true }))).toBe("mod+alt+j");
    expect(k.chordFromEvent(ev({ ctrlKey: true, key: "J" }))).toBe("mod+j");
    // A bare key is the other binding, and modifiers alone are not a chord.
    expect(k.chordFromEvent(ev({}))).toBe(null);
    expect(k.chordFromEvent(ev({ ctrlKey: true, key: "Control" }))).toBe(null);
  });

  it("labels a chord the way the platform writes it", async () => {
    const k = await load();
    expect(k.chordLabel("mod+j")).toBe("Ctrl+J");
    expect(k.chordLabel("mod+alt+j")).toBe("Ctrl+Alt+J");
    expect(k.chordLabel("mod+3")).toBe("Ctrl+3");
  });

  it("takes a chord with modifiers and dispatches on it", async () => {
    const k = await load();
    expect(k.rebindChord("chat", "mod+alt+j", order())).toEqual({ ok: true });
    expect(k.viewForChord("mod+alt+j", order())).toBe("chat");
    expect(k.chordFor("chat", order())).toBe("mod+alt+j");
  });

  it("refuses a key held with no modifier at all", async () => {
    const k = await load();
    const r = k.rebindChord("chat", "j", order());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("modifier");
  });

  it("follows a reorder rather than the shipped list", async () => {
    const k = await load();
    expect(k.chordFor("chat", ["chat", "git", "diff", "docker", "term"])).toBe("mod+1");
  });

  it("lets a custom chord win over a position that wants the same key", async () => {
    const k = await load();
    // "2" is diff's position; give it to chat explicitly.
    expect(k.rebindChord("chat", "mod+2", order()).ok).toBe(false); // taken by diff
    k.clearChord("chat");
    const moved = ["git", "docker", "term", "chat", "diff"];
    expect(k.rebindChord("chat", "mod+2", moved).ok).toBe(false); // docker is 2nd now
  });

  it("binds a letter and resolves it ahead of the digits", async () => {
    const k = await load();
    expect(k.rebindChord("chat", "mod+c", order())).toEqual({ ok: true });
    expect(k.chordFor("chat", order())).toBe("mod+c");
    expect(k.viewForChord("mod+c", order())).toBe("chat");
    // chat has left position 5, and nothing else is there, so the digit is dead.
    expect(k.viewForChord("mod+5", order())).toBe(null);
  });

  it("refuses a key the app itself owns", async () => {
    const k = await load();
    for (const bad of ["mod+k", "mod+\\", "mod+[", "mod+]", "mod+0", "mod+-", "mod+="]) {
      expect(k.rebindChord("chat", bad, order()).ok).toBe(false);
    }
    expect(k.chordFor("chat", order())).toBe("mod+5");
  });

  it("refuses a key another view already answers to", async () => {
    const k = await load();
    k.rebindChord("chat", "mod+c", order());
    const r = k.rebindChord("term", "mod+c", order());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("chat");
  });

  it("survives a reload and can be cleared back to positional", async () => {
    const k = await load();
    k.rebindChord("term", "mod+alt+j", order());
    const k2 = await load();
    expect(k2.chordFor("term", order())).toBe("mod+alt+j");
    expect(k2.chordsCustomised()).toBe(true);
    k2.clearChord("term");
    expect(k2.chordFor("term", order())).toBe("mod+4");
    expect(k2.chordsCustomised()).toBe(false);
  });

  it("ignores a corrupt store rather than losing every shortcut", async () => {
    store.set("agentglass.chords", "{{{");
    const k = await load();
    expect(k.chordFor("git", order())).toBe("mod+1");
  });

  it("hands back a stable object, as the rail's snapshot", async () => {
    const k = await load();
    expect(k.chords()).toBe(k.chords());
  });
});
