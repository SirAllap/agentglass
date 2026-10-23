/*
 * The four look preferences (density, interface font size, translucent window,
 * reduce motion): each is a registry setting an agent can reach, each is stored
 * and painted as an attribute on the root, and the stylesheet answers to every
 * one of those attributes.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { globalStubs } from "./stubGlobal.ts";
import { classOf } from "../../shared/settingClass.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
const attrs = new Map<string, string>();
const css = new Map<string, string>();
stubGlobal("document", {
  documentElement: {
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    hasAttribute: (k: string) => attrs.has(k),
    removeAttribute: (k: string) => void attrs.delete(k),
    style: { setProperty: (k: string, v: string) => void css.set(k, v), removeProperty: () => {}, getPropertyValue: () => "" },
  },
});
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
stubGlobal("navigator", { webdriver: true, userAgent: "Linux" });
stubGlobal("window", new EventTarget());
let osReduces = false;
stubGlobal("matchMedia", () => ({ matches: osReduces, addEventListener: () => {} }));

const R = await import("../src/lib/settingsRegistry.ts");
const L = await import("../src/lib/lookPrefs.ts");
const def = (id: string) => R.SETTING_DEFS.find((d) => d.id === id)!;

beforeEach(() => { store.clear(); attrs.clear(); css.clear(); attrs.set("data-theme", "graphite"); osReduces = false; });

describe("each look setting is a def with an agent class", () => {
  for (const id of ["appearance.density", "appearance.fontSize", "appearance.translucent", "appearance.reduceMotion"]) {
    it(id, () => {
      expect(def(id), "registered").toBeDefined();
      expect(def(id).level).toBe(2);
      expect(classOf(id)?.class).toBe("low");
    });
  }
});

describe("density", () => {
  it("paints an attribute for a chosen density and none for the default", () => {
    expect(def("appearance.density").set("compact").ok).toBe(true);
    expect(attrs.get("data-density")).toBe("compact");
    expect(def("appearance.density").get()).toBe("compact");
    def("appearance.density").set("comfortable");
    expect(attrs.has("data-density")).toBe(false);
    expect(store.has(L.DENSITY_KEY)).toBe(false);
  });
  it("refuses a value it does not offer", () => {
    for (const v of ["tight", "", 1, null]) expect(def("appearance.density").set(v).ok).toBe(false);
  });
});

describe("interface font size", () => {
  it("sets the multiplier the stylesheet reads", () => {
    def("appearance.fontSize").set(15);
    expect(attrs.get("data-ui-font")).toBe("15");
    expect(css.get("--agx-fs")).toBe(String(15 / 13));
    def("appearance.fontSize").set(13);
    expect(attrs.has("data-ui-font")).toBe(false);
    expect(css.get("--agx-fs")).toBe("1");
  });
  it("refuses a size that is not on the list, a string and a fraction", () => {
    for (const v of [11, 16, 13.5, "14", NaN]) expect(def("appearance.fontSize").set(v).ok).toBe(false);
  });
  it("a hand-edited key reads as the default", () => {
    store.set(L.UI_FONT_KEY, "400");
    expect(def("appearance.fontSize").get()).toBe(13);
  });
});

describe("translucent window", () => {
  it("is refused in a browser tab, where no desktop shows through, and says why", () => {
    const r = def("appearance.translucent").set(true);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("only the desktop app");
    expect(attrs.has("data-translucent")).toBe(false);
    expect(def("appearance.translucent").set(false).ok).toBe(true);
  });
  it("a stored on does not paint where it cannot show", () => {
    store.set(L.TRANSLUCENT_KEY, "1");
    L.applyLook();
    expect(attrs.has("data-translucent")).toBe(false);
  });
});

describe("reduce motion", () => {
  it("follows the system until somebody chooses", () => {
    osReduces = true;
    L.applyLook();
    expect(attrs.has("data-reduce-motion")).toBe(true);
    expect(def("appearance.reduceMotion").get()).toBe(true);
    expect(L.reducedMotion()).toBe(true);
  });
  it("a choice wins over the system, both ways", () => {
    osReduces = true;
    def("appearance.reduceMotion").set(false);
    expect(attrs.has("data-reduce-motion")).toBe(false);
    expect(L.reducedMotion()).toBe(false);
    osReduces = false;
    def("appearance.reduceMotion").set(true);
    expect(attrs.has("data-reduce-motion")).toBe(true);
    expect(L.reducedMotion()).toBe(true);
  });
  it("going back to the system's answer removes the choice", () => {
    def("appearance.reduceMotion").set(true);
    L.resetReduceMotion();
    expect(store.has(L.REDUCE_MOTION_KEY)).toBe(false);
  });
});

describe("a change can be put back", () => {
  it("undo restores what was there", () => {
    const r = def("appearance.density").set("roomy");
    if (!r.ok) throw new Error("set failed");
    r.revert();
    expect(def("appearance.density").get()).toBe("comfortable");
    expect(attrs.has("data-density")).toBe(false);
  });
});

const SRC = join(import.meta.dir, "..");
const html = readFileSync(join(SRC, "index.html"), "utf8");
const stylesheet = readFileSync(join(SRC, "src/index.css"), "utf8");

describe("the first frame and the stylesheet agree with the module", () => {
  it("web/index.html reads the same keys and writes the same attributes", () => {
    for (const k of [L.DENSITY_KEY, L.UI_FONT_KEY, L.REDUCE_MOTION_KEY]) expect(html, k).toContain(`"${k}"`);
    for (const a of ["data-density", "data-ui-font", "data-reduce-motion"]) expect(html, a).toContain(`"${a}"`);
    // The sizes the boot script accepts are the module's, 13 being the default and so no attribute.
    for (const px of L.UI_FONT_SIZES.filter((n) => n !== L.DEFAULT_UI_FONT)) expect(html).toContain(`"${px}"`);
  });

  it("the stylesheet answers to every attribute applyLook paints", () => {
    for (const a of ["data-density", "data-ui-font", "data-translucent", "data-reduce-motion"]) {
      expect(stylesheet, a).toContain(`[${a}`);
    }
  });

  it("every text size set by a class has a rule, so the font size reaches it", () => {
    const sizes = new Set<string>();
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx$/.test(p)) for (const m of readFileSync(p, "utf8").matchAll(/(?<![\w-])text-\[(\d+(?:\.\d+)?)px\]/g)) sizes.add(m[1]!);
      }
    };
    walk(join(SRC, "src"));
    // A size used by a handful of elements is a size somebody can ask to follow, so none is skipped.
    const missing = [...sizes].filter((n) => !stylesheet.includes(`[data-ui-font] [class~="text-[${n}px]"]`));
    expect(missing).toEqual([]);
  });
});
