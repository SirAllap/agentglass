/*
 * The phone's theme: two palettes, seven accents, and the rules between them.
 *
 * Everything here is about shared/palettes.ts, which is where the rules live
 * precisely so they can be checked without a phone. What a screen looks like is
 * not in this file and cannot be — that was verified on the emulator, and an
 * assertion about a hex value is not evidence about a screen.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ACCENTS, BASE, PHONE_ACCENTS, accentFor, cssVars, inkOn, paletteFor, polarityOf, sanitizeLook,
  type AccentId, type Palette, type Polarity,
} from "../../shared/palettes.ts";

const POLARITIES: Polarity[] = ["dark", "light"];
const IDS = PHONE_ACCENTS.map((a) => a.id);

/* WCAG, computed here from the definition rather than imported, so this file
 * checks the module's answer instead of agreeing with its arithmetic. */
const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("the accent, laid over a base", () => {
  test("it moves the primary and nothing else", () => {
    /*
     * The rule the desk's applyAccent follows, and the reason it matters here
     * is the terminal: success/warning/error/info are the pane's green, yellow,
     * red and blue. An accent that reached them would repaint somebody's build
     * output — a failing test would come back amber because the phone is set to
     * amber.
     */
    for (const polarity of POLARITIES) {
      const base = BASE[polarity];
      for (const id of IDS) {
        const painted = paletteFor(polarity, id);
        for (const key of Object.keys(base) as (keyof Palette)[]) {
          if (key === "primary" || key === "primaryHover") continue;
          expect(`${polarity}/${id}/${key}=${painted[key]}`).toBe(`${polarity}/${id}/${key}=${base[key]}`);
        }
      }
    }
  });

  test("neutral is the surface's own ink, not one grey for both", () => {
    // The whole reason neutral cannot be a row in ACCENTS beside the hues: a
    // grey that reads on #0d1117 is invisible on #ffffff. This is the assertion
    // that fails if somebody ever flattens it into a fixed pair.
    const dark = accentFor("dark", "neutral");
    const light = accentFor("light", "neutral");
    expect(dark.primary).toBe(BASE.dark.text);
    expect(light.primary).toBe(BASE.light.text);
    expect(contrast(dark.primary, BASE.dark.bg)).toBeGreaterThan(7);
    expect(contrast(light.primary, BASE.light.bg)).toBeGreaterThan(7);
  });

  test("the six hues are one value for both surfaces", () => {
    // Deliberate: the desk lays these same six over its light themes too, and an
    // accent whose hex depended on the surface would be a colour with two
    // meanings across the two apps.
    for (const accent of ACCENTS) {
      expect(accentFor("dark", accent.id)).toEqual(accentFor("light", accent.id));
    }
  });

  test("neutral is offered first, and every id is offered once", () => {
    expect(PHONE_ACCENTS[0]?.id).toBe("neutral");
    expect(new Set(IDS).size).toBe(IDS.length);
    // The desk's six, unchanged and all present — this file adds an axis to the
    // phone, it takes nothing off the desk.
    expect(IDS.slice(1)).toEqual(["blue", "violet", "green", "amber", "rose", "cyan"]);
  });

  test("an accent nobody has heard of paints the base rather than throwing", () => {
    // It arrives from storage. A phone that will not start because a preference
    // file says "purple" is worse than a phone with a blue cursor.
    const stray = accentFor("dark", "purple" as AccentId);
    expect(stray.primary).toBe(BASE.dark.primary);
  });
});

describe("the mode", () => {
  test("dark and light ignore the phone, system asks it", () => {
    expect(polarityOf("dark", false)).toBe("dark");
    expect(polarityOf("light", true)).toBe("light");
    expect(polarityOf("system", true)).toBe("dark");
    expect(polarityOf("system", false)).toBe("light");
  });

  test("a remembered look is validated field by field", () => {
    const fallback = { mode: "dark", accent: "blue" } as const;
    expect(sanitizeLook({ mode: "light", accent: "violet" }, fallback))
      .toEqual({ mode: "light", accent: "violet" });
    // Half a record is still a choice somebody made: the good half survives.
    expect(sanitizeLook({ mode: "system", accent: "chartreuse" }, fallback))
      .toEqual({ mode: "system", accent: "blue" });
    expect(sanitizeLook({ mode: "sepia", accent: "rose" }, fallback))
      .toEqual({ mode: "dark", accent: "rose" });
    // And the shapes storage can actually hand back when it has been emptied,
    // upgraded through a rename, or hand-edited.
    for (const raw of [null, undefined, 7, "dark", [], {}]) {
      expect(sanitizeLook(raw, fallback)).toEqual(fallback);
    }
  });
});

describe("ink on a coloured face", () => {
  test("it takes whichever of the two contrasts more", () => {
    /*
     * A luminance threshold gets this wrong where it counts. #3b82f6 is 0.48 of
     * the way up un-linearized, so a 0.5 cut hands blue the white ink at 3.68:1
     * when the dark ink is 5.15:1. The property, not the numbers, is what is
     * asserted — but both are measured over the fourteen faces that exist.
     */
    for (const polarity of POLARITIES) {
      for (const id of IDS) {
        const face = accentFor(polarity, id).primary;
        const chosen = inkOn(face);
        const other = chosen === "#ffffff" ? "#08111d" : "#ffffff";
        expect(`${polarity}/${id}`, `${polarity}/${id}: ${face}`)
          .toBe(contrast(face, chosen) >= contrast(face, other) ? `${polarity}/${id}` : "the other ink");
      }
    }
  });

  test("every face a button can have is readable", () => {
    // 4.4 rather than 4.5: violet is the tightest at 4.48, which is the price of
    // the desk's own hex values and is being paid knowingly.
    for (const polarity of POLARITIES) {
      for (const id of IDS) {
        const face = accentFor(polarity, id).primary;
        expect(contrast(face, inkOn(face))).toBeGreaterThan(4.4);
      }
      for (const face of [BASE[polarity].error, BASE[polarity].success]) {
        expect(contrast(face, inkOn(face))).toBeGreaterThan(4.4);
      }
    }
  });

  test("nothing paints its own ink by hand any more", () => {
    /*
     * `#08111d` was hardcoded at four call sites — the primary button, the
     * badge, the composer's send key and the terminal's — because the face was
     * always github-dark's blue. On a light screen with the neutral accent the
     * face IS #1f2328, so that literal is near-black on near-black. This is the
     * lock: the ink is computed from the face or it is not written at all.
     */
    const root = join(import.meta.dir, "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry === "node_modules" || entry === "web-shims") continue;
          walk(path);
        } else if (/\.tsx?$/.test(entry) && !/\.generated\./.test(entry)) {
          if (readFileSync(path, "utf8").includes("#08111d")) {
            offenders.push(path.slice(root.length + 1));
          }
        }
      }
    };
    walk(join(root, "app"));
    walk(join(root, "src"));
    expect(offenders, `${offenders.join(", ")} — use ink(face)`).toEqual([]);
  });
});

describe("the bases are the desk's, not new colours", () => {
  test("they are the two GitHub themes the dashboard still offers", () => {
    /*
     * The dashboard now imports these instead of holding them, so this checks
     * the direction that can still break: that it is the SAME two entries and
     * they still spell out as CSS custom properties. If somebody edits a hex
     * here, the desk's GitHub Dark changes with it — which is the point, and is
     * why the test names the file that would change.
     */
    const themes = readFileSync(join(import.meta.dir, "../../web/src/lib/themes.ts"), "utf8");
    expect(themes).toContain("cssVars(BASE.dark)");
    expect(themes).toContain("cssVars(BASE.light)");
    expect(cssVars(BASE.dark)["--bg"]).toBe("#0d1117");
    expect(cssVars(BASE.light)["--bg"]).toBe("#ffffff");
    expect(cssVars(BASE.dark)["--primary-hover"]).toBe("#79c0ff");
  });

  test("both are legible before an accent is anywhere near them", () => {
    for (const polarity of POLARITIES) {
      const base = BASE[polarity];
      expect(contrast(base.text, base.bg)).toBeGreaterThan(12);
      // text3 is the note under a control — the smallest type on the screen.
      expect(contrast(base.text3, base.bg)).toBeGreaterThan(4.5);
    }
  });
});
