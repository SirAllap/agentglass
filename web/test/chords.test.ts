import { beforeEach, describe, expect, it } from "bun:test";

/**
 * The workspace shortcuts.
 *
 * Two properties, and both of them are the kind that read as "the setting is
 * broken" rather than "the rule is wrong" when you get them backwards:
 *
 *  * Precedence. A custom chord has to beat the positional default, including
 *    when it takes a digit some other view currently sits on.
 *  * Reach. ⌘1..⌘9 count through the TOP drawer alone. They used to count
 *    through the whole rail, which handed a number to the dashboard, a web page
 *    and a chat — three icons sitting with settings and ports, none of which has
 *    ever had one. Moving a view down now takes its number away, and that is
 *    the assertion this file exists for.
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
// keybindings reaches views.ts, which reaches desktop.ts, which reaches api.ts
// and reads `location` at module scope. Without this it throws half-initialised
// and every import here dies on a TDZ for HAS_BROWSER — which reads as "the
// shortcuts are broken" rather than "the harness has no DOM".
(globalThis as unknown as { location: URL }).location ??= new URL("http://localhost:5173/");

// keybindings reads the layout out of this module rather than taking an order
// to index into, so the rail is the fixture. Not cache-busted: it has to be the
// same instance the freshly imported keybindings will read.
const views = await import("../src/components/workspace/views.ts");
const load = async () => await import(`../src/lib/keybindings.ts?c=${Math.random()}`);

/**
 * Say what is in the top drawer, exactly.
 *
 * Anything not named goes to `hidden`, because buildRail appends a view it has
 * not been told about to its shipped drawer — which would quietly extend the
 * numbered list past the end of what a test thinks it set up.
 */
const rail = (work: string[], utility: string[] = []) => {
  const named = new Set([...work, ...utility]);
  views.saveRail({
    work: work as never, utility: utility as never,
    hidden: views.VIEW_IDS.filter((id) => !named.has(id)) as never,
  });
};

beforeEach(() => {
  store.clear();
  views.resetRail(); // the module cache outlives store.clear()
});

describe("workspace chords", () => {
  it("falls back to top-drawer position when nothing is bound", async () => {
    const k = await load();
    rail(["git", "diff", "docker", "term", "chat"]);
    expect(k.chordFor("git")).toBe("mod+1");
    expect(k.chordFor("chat")).toBe("mod+5");
    expect(k.viewForChord("mod+3")).toBe("docker");
  });

  it("gives no number to a view outside the top drawer", async () => {
    const k = await load();
    rail(["git", "diff"], ["chat", "dash"]);
    expect(k.chordFor("git")).toBe("mod+1");
    expect(k.chordFor("diff")).toBe("mod+2");
    // The bottom drawer is not numbered, and the digit past the end is dead
    // rather than falling through to whatever is down there.
    expect(k.chordFor("chat")).toBe("");
    expect(k.chordFor("dash")).toBe("");
    expect(k.viewForChord("mod+3")).toBe(null);
    expect(k.viewForChord("mod+4")).toBe(null);
  });

  it("takes the number away when a view moves down, and gives it back", async () => {
    const k = await load();
    rail(["git", "diff", "term"]);
    expect(k.chordFor("term")).toBe("mod+3");
    rail(["git", "diff"], ["term"]);
    expect(k.chordFor("term")).toBe("");
    rail(["git", "diff", "term"]);
    expect(k.chordFor("term")).toBe("mod+3");
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
    rail(["git", "diff", "docker", "term", "chat"]);
    expect(k.rebindChord("chat", "mod+alt+j")).toEqual({ ok: true });
    expect(k.viewForChord("mod+alt+j")).toBe("chat");
    expect(k.chordFor("chat")).toBe("mod+alt+j");
    expect(k.hasCustomChord("chat")).toBe(true);
  });

  it("lets the bottom drawer be given a key by hand", async () => {
    // Losing the number is the point; losing the ability to reach it at all
    // would be a different, worse change.
    const k = await load();
    rail(["git", "diff"], ["chat"]);
    expect(k.rebindChord("chat", "mod+alt+c")).toEqual({ ok: true });
    expect(k.chordFor("chat")).toBe("mod+alt+c");
    expect(k.viewForChord("mod+alt+c")).toBe("chat");
  });

  it("still answers for a hidden view somebody bound by hand", async () => {
    // Hiding takes a view off the rail, not out of the app. The caller puts it
    // back on the way in; a key that silently does nothing is the worse answer.
    const k = await load();
    rail(["git", "diff"]);
    expect(views.isVisibleView("docker")).toBe(false);
    expect(k.rebindChord("docker", "mod+alt+d")).toEqual({ ok: true });
    expect(k.viewForChord("mod+alt+d")).toBe("docker");
  });

  it("refuses a key held with no modifier at all", async () => {
    const k = await load();
    rail(["git", "diff", "chat"]);
    const r = k.rebindChord("chat", "j");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("modifier");
  });

  it("follows a reorder rather than the shipped list", async () => {
    const k = await load();
    rail(["chat", "git", "diff", "docker", "term"]);
    expect(k.chordFor("chat")).toBe("mod+1");
  });

  it("lets a custom chord win over a position that wants the same key", async () => {
    const k = await load();
    rail(["git", "diff", "docker", "term", "chat"]);
    // "2" is diff's position; asking for it explicitly has to be refused while
    // diff is still there to answer it.
    expect(k.rebindChord("chat", "mod+2").ok).toBe(false);
    rail(["git", "docker", "term", "chat", "diff"]);
    expect(k.rebindChord("chat", "mod+2").ok).toBe(false); // docker is 2nd now
  });

  it("binds a letter and resolves it ahead of the digits", async () => {
    const k = await load();
    rail(["git", "diff", "docker", "term", "chat"]);
    expect(k.rebindChord("chat", "mod+c")).toEqual({ ok: true });
    expect(k.chordFor("chat")).toBe("mod+c");
    expect(k.viewForChord("mod+c")).toBe("chat");
    // chat has left position 5, and nothing else is there, so the digit is dead.
    expect(k.viewForChord("mod+5")).toBe(null);
  });

  it("refuses a key the app itself owns", async () => {
    const k = await load();
    rail(["git", "diff", "docker", "term", "chat"]);
    for (const bad of ["mod+k", "mod+\\", "mod+[", "mod+]", "mod+0", "mod+-", "mod+="]) {
      expect(k.rebindChord("chat", bad).ok).toBe(false);
    }
    expect(k.chordFor("chat")).toBe("mod+5");
  });

  it("refuses a key another view already answers to, and says which", async () => {
    const k = await load();
    rail(["git", "diff", "docker", "term", "chat"]);
    k.rebindChord("chat", "mod+c");
    const r = k.rebindChord("term", "mod+c");
    expect(r.ok).toBe(false);
    // The label, not the id: "already opens chat" is a sentence about a
    // variable name, and the dialog it lands in says "Chat" everywhere else.
    if (!r.ok) expect(r.error).toContain("Chat");
  });

  it("survives a reload and can be cleared back to positional", async () => {
    const k = await load();
    rail(["git", "diff", "docker", "term", "chat"]);
    k.rebindChord("term", "mod+alt+j");
    const k2 = await load();
    expect(k2.chordFor("term")).toBe("mod+alt+j");
    expect(k2.chordsCustomised()).toBe(true);
    k2.clearChord("term");
    expect(k2.chordFor("term")).toBe("mod+4");
    expect(k2.hasCustomChord("term")).toBe(false);
    expect(k2.chordsCustomised()).toBe(false);
  });

  it("ignores a corrupt store rather than losing every shortcut", async () => {
    store.set("agentglass.chords", "{{{");
    const k = await load();
    rail(["git", "diff", "docker", "term", "chat"]);
    expect(k.chordFor("git")).toBe("mod+1");
  });

  it("hands back a stable object, as the rail's snapshot", async () => {
    const k = await load();
    expect(k.chords()).toBe(k.chords());
  });
});
