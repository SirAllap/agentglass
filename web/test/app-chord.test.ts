/*
 * The key that opens the file palette, and why it is a preference.
 *
 * It is the only binding in the app that reaches past a running shell — the
 * terminal is told to hand it over instead of writing it to the PTY. That makes
 * it the one most likely to collide with something already bound inside tmux,
 * readline or vim, and so the one that most needs to be movable. "Ante la duda
 * déjalo para poder editarlo en los settings" is exactly the right instinct and
 * this is the test of it.
 *
 * The first case here is a defect found while building it, not a hypothetical:
 * the chord encoder dropped Shift for letter keys, so Ctrl+Shift+P and Ctrl+P
 * encoded identically. Shipping the shifted default on top of that encoder
 * would have bound the app to readline's previous-command.
 */
import { beforeEach, describe, expect, it } from "bun:test";

// keybindings.ts reaches views.ts -> desktop.ts -> api.ts, which reads
// `location` at module scope. Stubbed here rather than relied upon: without it
// this file passes only when some earlier test file happens to have stubbed it
// first, which is a suite that goes red when you run one test on its own.
(globalThis as unknown as { location: unknown }).location = { hostname: "localhost", origin: "http://localhost:4000" };

const store = new Map<string, string>();
// @ts-expect-error — a localStorage good enough for a module that only reads,
// writes and occasionally finds nothing.
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};

const kb = await import("../src/lib/keybindings.ts");

const press = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

beforeEach(() => { store.clear(); kb.resetAppChords(); kb.resetChords(); kb.resetBindings(); });

describe("what the keyboard actually sends", () => {
  it("tells Ctrl+Shift+P apart from Ctrl+P", () => {
    // The browser sends the uppercase letter when Shift is held, so the base
    // identity is recoverable and the modifier is real information.
    const plain = kb.chordFromEvent(press("p", { ctrlKey: true }));
    const shifted = kb.chordFromEvent(press("P", { ctrlKey: true, shiftKey: true }));
    expect(plain).toBe("mod+p");
    expect(shifted).toBe("mod+shift+p");
    expect(shifted).not.toBe(plain);
  });

  it("still ignores Shift on punctuation, where the shifted form IS the key", () => {
    // Shift+1 arrives as "!" — recording shift as well would build a chord the
    // keyboard can never send.
    expect(kb.chordFromEvent(press("!", { ctrlKey: true, shiftKey: true }))).toBe("mod+!");
  });

  it("keeps the numbered view chords addressable", () => {
    expect(kb.chordFromEvent(press("1", { ctrlKey: true }))).toBe("mod+1");
  });
});

describe("the shipped key", () => {
  it("is the shifted one, which a shell does not want", () => {
    // Ctrl+P is readline's previous-command; every terminal-adjacent app that
    // has solved this picked the shifted form.
    expect(kb.appChordFor("files.palette")).toBe("mod+shift+p");
    expect(kb.hasCustomAppChord("files.palette")).toBe(false);
  });

  it("opens the palette and nothing else", () => {
    expect(kb.appActionForChord("mod+shift+p")).toBe("files.palette");
    expect(kb.appActionForChord("mod+p")).toBeNull();
    // And a view chord is not an app action, or App would run both.
    expect(kb.appActionForChord("mod+1")).toBeNull();
  });
});

describe("moving it", () => {
  it("takes a combination and remembers it", () => {
    expect(kb.rebindAppChord("files.palette", "mod+alt+f")).toEqual({ ok: true });
    expect(kb.appChordFor("files.palette")).toBe("mod+alt+f");
    expect(kb.hasCustomAppChord("files.palette")).toBe(true);
    expect(kb.appChordsCustomised()).toBe(true);
    // The old key stops opening it — otherwise moving a binding would add one.
    expect(kb.appActionForChord("mod+shift+p")).toBeNull();
    expect(kb.appActionForChord("mod+alt+f")).toBe("files.palette");
  });

  it("refuses a bare key, because a shell would eat it", () => {
    const r = kb.rebindAppChord("files.palette", "p");
    expect(r.ok).toBe(false);
    expect(kb.appChordFor("files.palette")).toBe("mod+shift+p");
  });

  it("refuses the keys the app cannot give up", () => {
    // Lose ⌘K or zoom and there is no way back to them from the keyboard.
    for (const reserved of ["mod+k", "mod+\\", "mod+0", "mod+="]) {
      expect(kb.rebindAppChord("files.palette", reserved).ok).toBe(false);
    }
  });

  it("refuses a chord that already opens a view, rather than stealing it", () => {
    // mod+1 is the first tab in the work drawer. Silently unbinding it would
    // leave a shortcut that stopped working and no clue why.
    const r = kb.rebindAppChord("files.palette", "mod+1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("already opens");
  });

  it("refuses in the other direction too — a view cannot take this key", () => {
    // App resolves views first, so without this check binding a view to the
    // palette's chord would shadow it and the palette setting would look dead.
    const r = kb.rebindChord("git", "mod+shift+p");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Find a file");
  });

  it("survives a reload", () => {
    kb.rebindAppChord("files.palette", "mod+alt+f");
    expect(store.get("agentglass.appChords")).toContain("mod+alt+f");
  });

  it("goes back to the shipped key on reset", () => {
    kb.rebindAppChord("files.palette", "mod+alt+f");
    kb.resetAppChords();
    expect(kb.appChordFor("files.palette")).toBe("mod+shift+p");
    expect(kb.appChordsCustomised()).toBe(false);
  });
});

describe("what the terminal hands over", () => {
  it("gives up the palette's key and keeps everything else", async () => {
    const { isAppChord } = await import("../src/lib/termKeys.ts");
    expect(isAppChord(press("P", { ctrlKey: true, shiftKey: true }))).toBe(true);
    // Ctrl+P is the shell's — previous command — and must still reach it.
    expect(isAppChord(press("p", { ctrlKey: true }))).toBe(false);
    expect(isAppChord(press("c", { ctrlKey: true }))).toBe(false);
    expect(isAppChord(press("a", {}))).toBe(false);
  });

  it("follows the key when it is moved, in the same breath", () => {
    // A copy of the default kept in the terminal would leave one key that opens
    // nothing and another that does two things at once.
    kb.rebindAppChord("files.palette", "mod+alt+f");
    expect(kb.appActionForChord(kb.chordFromEvent(press("f", { ctrlKey: true, altKey: true }))!)).toBe("files.palette");
    expect(kb.appActionForChord(kb.chordFromEvent(press("P", { ctrlKey: true, shiftKey: true }))!)).toBeNull();
  });
});
