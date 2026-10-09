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
  ACCENTS, BASE, PANE, PHONE_ACCENTS, accentFor, cssVars, deskPalette, inkOn, paletteFor, phonePalette, polarityOf,
  resolveLook, sanitizeLook,
  type AccentId, type Palette, type Polarity,
} from "../../shared/palettes.ts";
import { currentLook, tint } from "../src/theme.ts";

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
    // phone, it takes nothing off the desk. Teal is the seventh and it is in
    // ACCENTS rather than in a phone-only list on purpose: the rule above is
    // that an accent named the same in both products IS the same hex, and a
    // colour only one of them can spell would be the first exception to it.
    expect(IDS.slice(1)).toEqual(["blue", "violet", "green", "amber", "rose", "cyan", "teal"]);
  });

  test("an accent nobody has heard of paints the base rather than throwing", () => {
    // It arrives from storage. A phone that will not start because a preference
    // file says "purple" is worse than a phone with a blue cursor.
    const stray = accentFor("dark", "purple" as AccentId);
    expect(stray.primary).toBe(BASE.dark.primary);
  });

  test("the base it falls back to is the caller's, not this file's", () => {
    /* The phone does not wear BASE any more, so this fallback is the one place
       an unreadable preference could put the desk's blue on a PANE ground.
       Reading the module constant here instead of the argument would do exactly
       that, and it would only ever show on somebody's phone. */
    const stray = accentFor("dark", "purple" as AccentId, PANE);
    expect(stray.primary).toBe(PANE.dark.primary);
    expect(stray.hover).toBe(PANE.dark.primaryHover);
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
      .toEqual({ mode: "desk", accent: "blue" });
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

describe("tint", () => {
  test("appends the alpha as two hex digits", () => {
    // React Native reads #RRGGBBAA. Eight digits and not seven: a single digit
    // makes a seven-character string, which RN silently draws as transparent.
    expect(tint("#3fb950", 0.14)).toBe("#3fb95024");
    expect(tint("#3fb950", 0.14).length).toBe(9);
  });

  test("a small alpha still gets two digits", () => {
    // 0.02 * 255 rounds to 5, which is "5" before padding. This is the case the
    // padStart exists for.
    expect(tint("#000000", 0.02)).toBe("#00000005");
  });

  test("the ends are the ends", () => {
    expect(tint("#ffffff", 0)).toBe("#ffffff00");
    expect(tint("#ffffff", 1)).toBe("#ffffffff");
  });

  test("an alpha outside 0..1 is clamped rather than wrapped", () => {
    /* Wrapping would be the worst failure available here: 1.2 * 255 is 306,
       which is 0x132 — three digits, a ten-character colour, and RN draws
       nothing. Clamping makes an out-of-range alpha merely wrong. */
    expect(tint("#ffffff", 1.2)).toBe("#ffffffff");
    expect(tint("#ffffff", -1)).toBe("#ffffff00");
  });

  test("it follows the live palette rather than a frozen hex", () => {
    // The whole reason it exists: the diff's washes used to be github-dark's
    // green and red written out as rgba(), on a phone that wears PANE.
    expect(tint(PANE.dark.error, 0.14).startsWith(PANE.dark.error)).toBe(true);
    expect(tint(PANE.light.error, 0.14).startsWith(PANE.light.error)).toBe(true);
  });
});

describe("the phone's palette can be read", () => {
  /*
   * Measured before the change: ink on the violet button 4.48:1 on dark, and
   * the teal accent as text on a white card 1.7:1 on light. Every accent is
   * now walked to a shade that reads — as text on both grounds, and as a fill
   * under its own ink.
   */
  test("every accent, both polarities, as text and as a fill", () => {
    for (const polarity of POLARITIES) {
      for (const id of IDS) {
        const p = phonePalette(polarity, id as AccentId);
        expect(contrast(p.primary, p.bg), `${polarity}/${id} on the ground`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p.primary, p.bg2), `${polarity}/${id} on a card`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(inkOn(p.primary), p.primary), `${polarity}/${id} under its ink`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("dark violet takes the light member of its pair, as the design measured", () => {
    expect(phonePalette("dark", "violet").primary).toBe("#a78bfa");
  });

  test("an accent that already reads is left exactly as the desk has it", () => {
    expect(phonePalette("dark", "teal").primary).toBe("#4dd6c1");
  });

  test("the notes under a control read on both grounds", () => {
    for (const polarity of POLARITIES) {
      expect(contrast(PANE[polarity].text3, PANE[polarity].bg2)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(PANE[polarity].text3, PANE[polarity].bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/*
 * "Match the computer": the phone wears the desk's palette, and falls back to
 * its own when the desk has nothing usable to say.
 *
 * WARM is the shape `GET /theme/current` answers for a warm light theme — a
 * paper ground and a brown-black ink, none of it any phone palette.
 */
const WARM = {
  bg: "#fdf6e3", bg2: "#eee8d5", bg3: "#e4dcc3", bg4: "#d8cfb0",
  text: "#3b3a2f", text2: "#586e75", text3: "#657b83", text4: "#93a1a1",
  border: "#e4dcc3", border2: "#d3c9a8",
  primary: "#2aa198", primaryHover: "#1f7f78",
  success: "#2f7d1f", warning: "#8a6500", error: "#c4392b", info: "#1f6fb5",
};

describe("match the computer", () => {
  test("a warm desk paints the whole palette warm, and reads", () => {
    const { palette, polarity } = resolveLook({ mode: "desk", accent: "teal" }, true, WARM);
    expect(polarity).toBe("light");
    // The phone is dark-by-OS here and the desk is light: the desk wins.
    for (const key of ["bg", "bg2", "bg3", "bg4", "text", "text2", "border", "success", "error"] as const) {
      expect(`${key}=${palette[key]}`).toBe(`${key}=${WARM[key]}`);
    }
    expect(contrast(palette.text, palette.bg)).toBeGreaterThan(7);
    // The accent is still the owner's, and is walked until it reads on THESE grounds.
    expect(contrast(palette.primary, palette.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.primary, palette.bg2)).toBeGreaterThanOrEqual(4.5);
  });

  test("a dark desk is dark whatever the OS says", () => {
    const dark = { ...PANE.dark, bg: "#1e1e2e", bg2: "#313244", text: "#cdd6f4" };
    for (const os of [true, false]) {
      const { palette, polarity } = resolveLook({ mode: "desk", accent: "blue" }, os, dark);
      expect(polarity).toBe("dark");
      expect(palette.bg).toBe("#1e1e2e");
    }
  });

  test("no theme, or one that is not a palette, is phone mode", () => {
    // `{theme: null}` is what a computer with nothing picked answers; the rest
    // are the shapes a half-written or hostile answer takes.
    const phone = (os: boolean) => phonePalette(os ? "dark" : "light", "teal");
    for (const os of [true, false]) {
      for (const vars of [null, undefined, 7, "light", [], {}, { bg: "#fff" }, { bg: "url(x)", text: "red" }]) {
        const r = resolveLook({ mode: "desk", accent: "teal" }, os, vars);
        expect(r.palette).toEqual(phone(os));
        expect(r.polarity).toBe(os ? "dark" : "light");
      }
    }
  });

  test("a colour that is not a plain hex falls back for that slot only", () => {
    const got = deskPalette({ ...WARM, border: "javascript:1", info: 5 }, "teal");
    expect(got).not.toBeNull();
    expect(got!.palette.border).toBe(PANE.light.border);
    expect(got!.palette.info).toBe(PANE.light.info);
    expect(got!.palette.bg).toBe(WARM.bg);
  });

  test("Light and Dark are pins the desk never overrules", () => {
    expect(resolveLook({ mode: "dark", accent: "teal" }, false, WARM).palette).toEqual(phonePalette("dark", "teal"));
    expect(resolveLook({ mode: "light", accent: "teal" }, true, WARM).palette).toEqual(phonePalette("light", "teal"));
    // System still follows the OS and ignores the desk.
    expect(resolveLook({ mode: "system", accent: "teal" }, true, WARM).palette).toEqual(phonePalette("dark", "teal"));
  });

  test("it is what a new install gets, and what was stored stays", () => {
    // Nothing is stored in a test process, so this is the shipped look.
    expect(currentLook().mode).toBe("desk");
    const fallback = { mode: "desk", accent: "teal" } as const;
    expect(sanitizeLook({ mode: "dark", accent: "rose" }, fallback)).toEqual({ mode: "dark", accent: "rose" });
    expect(sanitizeLook({ mode: "light" }, fallback)).toEqual({ mode: "light", accent: "teal" });
    expect(sanitizeLook({ mode: "desk", accent: "blue" }, fallback)).toEqual({ mode: "desk", accent: "blue" });
  });
});

describe("the desk does not outlive its computer", () => {
  test("forgetting a computer drops its theme before the next one is paired", () => {
    const src = readFileSync(join(import.meta.dir, "../src/state/host-context.tsx"), "utf8");
    const at = src.indexOf("forget: async");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, src.indexOf("},", at))).toContain("setDeskTheme(null)");
  });
});
