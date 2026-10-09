/*
 * Accent colour — a control that layers on top of a theme without belonging to
 * it.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
import { ACCENTS, currentAccent, lastAccent, setAccentPref } from "../src/lib/accent.ts";
const stubGlobal = globalStubs();

const isHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);

describe("accent colours", () => {
  test("a no-override 'Theme' default plus real colours", () => {
    const def = ACCENTS.find((a) => a.id === "");
    expect(def, "the default entry").toBeDefined();
    expect(def!.primary, "default overrides nothing").toBe("");
    const colours = ACCENTS.filter((a) => a.id);
    expect(colours.length).toBeGreaterThanOrEqual(4);
    for (const a of colours) {
      expect(isHex(a.primary), `${a.id} primary = ${a.primary}`).toBe(true);
      expect(isHex(a.hover), `${a.id} hover = ${a.hover}`).toBe(true);
    }
  });

  test("ids are unique", () => {
    const ids = ACCENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no accent saved → the theme's own primary (empty id)", () => {
    expect(currentAccent()).toBe("");
  });
});

/*
 * The follow switch has to be reversible. Turning it on is the absence of an
 * override, so the id it writes is "" — and if that were all it wrote, turning
 * it off again would land on no colour at all and the row would read as broken.
 * The colour is remembered on the way in, under its own key.
 */
describe("following the theme is reversible", () => {
  let store: Map<string, string>;

  beforeAll(() => {
    store = new Map();
    stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });

  test("never picked one → teal, the colour the phone starts on", () => {
    store.clear();
    expect(lastAccent()).toBe("teal");
  });

  test("a colour picked, then the switch on → the colour is still what comes back", () => {
    store.clear();
    setAccentPref("violet");
    expect(currentAccent()).toBe("violet");
    setAccentPref("");                    // the switch going on
    expect(currentAccent()).toBe("");     // no override any more
    expect(lastAccent()).toBe("violet");  // and the switch can come back off
  });
});
