/*
 * The persona's arithmetic, and the promise its curated lists make.
 *
 * Two very different failures live under this one file, and neither of them is
 * visible in a diff.
 *
 * THE FIRST IS THE SHADER. The 295 vendored PNGs are masks — flat red, green
 * and blue silhouettes — and the whole portrait is one per-pixel function away
 * from being a red blob. Get the channel mapping backwards and it still
 * renders, still animates, still passes a type check; it just looks wrong, and
 * "looks wrong" is not something a build can tell you. So the mapping is pinned
 * against four hand-built pixels, one per path through the shader, and the
 * five-tone ramp is pinned against Endesga 32 — the published palette the art
 * was drawn to, which makes it a golden somebody else chose.
 *
 * THE SECOND IS THE CURATION. `parts.ts` names about sixty option ids by hand.
 * A typo in one of them is not an error anywhere: `layerUrl` returns undefined,
 * the composite skips the layer, and the persona renders with no mouth. This
 * checks every curated id against the files on disk.
 *
 * Why the catalogue is rebuilt here from `node:fs` instead of imported from
 * `layers.ts`: that module finds the art through Vite's `import.meta.glob`,
 * which is a compile-time macro and is not a function in bun. The parse rule it
 * uses lives in `parts.ts` precisely so this side can apply the same rule to
 * the same directory and compare like with like.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  BEARDS,
  BODIES,
  BROWS,
  DEFAULT_COSMETIC,
  EARS,
  EYES,
  EYEWEAR,
  HAIRSTYLES,
  HEADWEAR,
  HORNS,
  MOUTHS,
  NECKWEAR,
  NOSES,
  ORDER,
  OUTFITS,
  PRESETS,
  SLOTS,
  VARIANT_SUFFIX,
  applyPreset,
  personaPlan,
  splitLayerFile,
  type Slot,
  type Step,
} from "../src/components/understudy/persona/parts.ts";
import { validateCosmetic } from "../src/components/understudy/persona/cosmeticStore.ts";
import { NATURAL_LIPS, SWATCHES, castTones, lipTones, swatch } from "../src/components/understudy/persona/swatches.ts";
import {
  castShadow,
  material,
  over,
  ramp,
  tint,
  type Pixels,
} from "../src/components/understudy/persona/shader.ts";

/* ------------------------------------------------------------------- ramp */

describe("the five-tone ramp", () => {
  /**
   * Endesga 32's skin ramp, which is the reference the numbers were fitted to.
   *
   * One unit of tolerance per channel, and it is not slack: the ramp is HSV
   * arithmetic on a palette somebody chose by eye, so the last step of the
   * round trip through 8-bit integers lands a unit either side. Two units is
   * where a rung starts reading as a different swatch, and an earlier draft of
   * the multipliers missed the highlight by three — see the comment on
   * SATURATION in shader.ts.
   */
  test("#b86f50 gives back Endesga 32's skin, within one unit per channel", () => {
    const want = ["#3e2731", "#733e39", "#b86f50", "#e4a672", "#ead4aa"];
    const got = ramp("#b86f50");
    const off: string[] = [];
    got.forEach((hex, i) => {
      for (let k = 0; k < 3; k++) {
        const a = parseInt(hex.slice(1 + k * 2, 3 + k * 2), 16);
        const b = parseInt(want[i]!.slice(1 + k * 2, 3 + k * 2), 16);
        if (Math.abs(a - b) > 1) off.push(`ramp[${i}] channel ${k}: ${hex} vs ${want[i]}`);
      }
    });
    expect(off.join("\n") || null).toBeNull();
  });

  test("the mid tone comes back untouched", () => {
    // Index 2 has a hue delta of 0 and both multipliers at 1.0. If this ever
    // moves, every colour the user picks is silently not the colour they got.
    expect(ramp("#b86f50")[2]).toBe("#b86f50");
    expect(ramp("#0099db", true)[2]).toBe("#0099db");
  });

  test("it darkens monotonically from shadow to highlight", () => {
    const lum = (hex: string) =>
      [1, 3, 5].reduce((s, i) => s + parseInt(hex.slice(i, i + 2), 16), 0);
    for (const mid of ["#b86f50", "#733e39", "#3a4466", "#feae34", "#0099db"]) {
      const five = ramp(mid).map(lum);
      expect(five, mid).toEqual([...five].sort((a, b) => a - b));
    }
  });

  test("a grey has no hue to rotate and still ramps", () => {
    // Saturation is 0, so every rung is grey; only the value multipliers act.
    const five = ramp("#808080");
    for (const hex of five) expect(hex.slice(1, 3)).toBe(hex.slice(3, 5));
  });

  test("the shader gets the top rung as light and the mid as dark", () => {
    const five = ramp("#b86f50");
    const m = material("#b86f50");
    // Not a mix-up: the masks fill the broad areas with GREEN, so the light
    // tone is the colour of the face and the dark tone is what shades it.
    expect(m.light).toBe(five[4]);
    expect(m.dark).toBe(five[2]);
    expect(m.shadow).toBe(five[0]);
  });
});

/* ----------------------------------------------------------------- shader */

/** Four pixels in a row, RGBA, so each path through the shader gets one. */
function fourPixels(px: readonly [number, number, number, number][]): Pixels {
  const data = new Uint8ClampedArray(px.length * 4);
  px.forEach((p, i) => data.set(p, i * 4));
  return { data, width: px.length, height: 1 };
}

const hexAt = (out: Pixels, i: number) =>
  `#${[0, 1, 2].map((k) => out.data[i * 4 + k]!.toString(16).padStart(2, "0")).join("")}`;

describe("tint", () => {
  const TONES = { light: "#ead4aa", dark: "#b86f50", shadow: "#3e2731" };

  test("R is the dark tone, G the light tone, B the shadow tone", () => {
    const out = tint(
      fourPixels([
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [128, 128, 128, 255],
      ]),
      TONES,
    );
    expect(hexAt(out, 0)).toBe("#b86f50");
    expect(hexAt(out, 1)).toBe("#ead4aa");
    expect(hexAt(out, 2)).toBe("#3e2731");
  });

  test("a neutral pixel ignores all three tones and lerps black to white", () => {
    // This is the path that draws eye whites, pupils and the glint on a lens:
    // where the channels are equal, `weight` collapses and the tinted term
    // contributes nothing at all.
    const out = tint(fourPixels([[128, 128, 128, 255]]), TONES);
    const mid = out.data[0]!;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(255);
    expect(out.data[1]).toBe(mid);
    expect(out.data[2]).toBe(mid);

    // And it follows black/white when they are given, not the material.
    const steered = tint(fourPixels([[128, 128, 128, 255]]), { ...TONES, black: "#000000", white: "#0000ff" });
    expect(steered.data[0]).toBe(0);
    expect(steered.data[2]).toBeGreaterThan(100);
  });

  test("#808000 — the art's in-between tone — lands between dark and light", () => {
    // Half red, half green, no blue. 610 of the 3,895 opaque pixels in
    // body/male01.png are this, and it is what stops a face being two flat
    // colours. It has to resolve to the midpoint of `dark` and `light`.
    const out = tint(fourPixels([[128, 128, 0, 255]]), TONES);
    const r = out.data[0]!;
    expect(r).toBeGreaterThan(0xb8);
    expect(r).toBeLessThan(0xea);
  });

  test("alpha comes through byte for byte, and clear stays clear", () => {
    const out = tint(
      fourPixels([
        [255, 0, 0, 255],
        [0, 255, 0, 128],
        [0, 0, 255, 1],
        [255, 255, 255, 0],
      ]),
      TONES,
    );
    expect([out.data[3], out.data[7], out.data[11], out.data[15]]).toEqual([255, 128, 1, 0]);
    // Nothing is premultiplied: the half-transparent pixel is the same colour
    // as an opaque one would be.
    expect(hexAt(out, 1)).toBe("#ead4aa");
    // A fully clear pixel keeps zeroed colour rather than picking up a fringe.
    expect([out.data[12], out.data[13], out.data[14]]).toEqual([0, 0, 0]);
  });

  test("the source is not modified", () => {
    const src = fourPixels([[255, 0, 0, 255]]);
    tint(src, TONES);
    expect([...src.data]).toEqual([255, 0, 0, 255]);
  });

  test("a `_shadow` mask comes out one flat shade of the skin it lands on", () => {
    // All 63 of them are a flat #808000, and they are the shadow a layer casts
    // on the FACE, so they are tinted with the skin's ramp and not their own.
    const out = tint(fourPixels([[128, 128, 0, 255]]), castShadow("#b86f50"));
    expect(hexAt(out, 0)).toBe(ramp("#b86f50")[1]);
  });
});

describe("over", () => {
  test("an opaque layer replaces what is under it and a clear one does not", () => {
    const dst = fourPixels([
      [10, 20, 30, 255],
      [10, 20, 30, 255],
    ]);
    over(dst, fourPixels([
      [200, 100, 50, 255],
      [200, 100, 50, 0],
    ]));
    expect(Array.from(dst.data.slice(0, 4))).toEqual([200, 100, 50, 255]);
    expect(Array.from(dst.data.slice(4, 8))).toEqual([10, 20, 30, 255]);
  });

  test("onto nothing, a layer keeps its own colour", () => {
    // The composite starts on a zeroed buffer, so the first mask down must not
    // be blended toward transparent black — that is how a face comes out dim.
    const dst = fourPixels([[0, 0, 0, 0]]);
    over(dst, fourPixels([[234, 212, 170, 255]]));
    expect([...dst.data]).toEqual([234, 212, 170, 255]);
  });
});

/* -------------------------------------------------------------- catalogue */

const ART = resolve(import.meta.dir, "..", "src", "components", "understudy", "persona", "layers");

/** The same rule `layers.ts` applies to the glob, applied to the directory. */
function catalogueFromDisk(): Record<Slot, Set<string>> {
  const found = {} as Record<Slot, Set<string>>;
  for (const slot of SLOTS) found[slot] = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.endsWith(".png")) continue;
      const slot = relative(ART, dir) as Slot;
      if (!(slot in found)) continue;
      found[slot].add(splitLayerFile(entry.slice(0, -4)).id);
    }
  };
  walk(ART);
  return found;
}

const CAT = catalogueFromDisk();

describe("the vendored art", () => {
  test("every slot is a directory that exists and has something in it", () => {
    const empty = SLOTS.filter((s) => CAT[s].size === 0);
    expect(empty.join(", ") || null).toBeNull();
  });

  test("the variant suffixes fold, so an option is not counted four times", () => {
    // glasses01, glasses01_shadow, glasses01_reflection and
    // glasses01_reflection_shadow are ONE pair of glasses. Before the
    // longest-suffix-first rule, the last of those parsed as an option called
    // "glasses01_reflection" that resolved to no file at all.
    expect(CAT.glasses.has("glasses01")).toBe(true);
    expect(CAT.glasses.has("glasses01_reflection")).toBe(false);
    expect(CAT.glasses.has("glasses01_shadow")).toBe(false);
    expect(splitLayerFile("glasses01_reflection_shadow")).toEqual({
      id: "glasses01",
      variant: "reflection-shadow",
    });
    // And a name that merely contains an underscore is left whole.
    expect(splitLayerFile("eye_patch01_left")).toEqual({ id: "eye_patch01_left", variant: "base" });
  });

  test("every suffix in the table is one the art actually uses", () => {
    // An entry for a suffix nothing is named with is a rule nothing checks.
    const names = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (entry.endsWith(".png")) names.add(entry.slice(0, -4));
      }
    };
    walk(ART);
    const stale = Object.entries(VARIANT_SUFFIX)
      .filter(([, sfx]) => sfx && ![...names].some((n) => n.endsWith(sfx)))
      .map(([v]) => v);
    expect(stale.join(", ") || null).toBeNull();
  });
});

describe("the curated lists name files that exist", () => {
  const check = (slot: Slot, ids: readonly string[], where: string) => {
    const missing = ids.filter((id) => !CAT[slot].has(id));
    expect(missing.join(", ") || null, `${where} → ${slot}`).toBeNull();
  };

  test("bodies, faces and clothes", () => {
    check("body", BODIES.map((o) => o.id), "BODIES");
    check("cloths", OUTFITS.map((o) => o.id), "OUTFITS");
    check("eyes", EYES.map((o) => o.id), "EYES");
    check("brows", BROWS.map((o) => o.id), "BROWS");
    check("nose", NOSES.map((o) => o.id), "NOSES");
    check("mouth", MOUTHS.map((o) => o.id), "MOUTHS");
    check("beard", BEARDS.map((o) => o.id), "BEARDS");
    check("glasses", EYEWEAR.map((o) => o.id), "EYEWEAR");
    check("neck", NECKWEAR.map((o) => o.id), "NECKWEAR");
    check("ears", EARS.map((o) => o.id), "EARS");
    check("horns", HORNS.map((o) => o.id), "HORNS");
    // The three things in hair/base that are not hair.
    check("hair/base", HEADWEAR.map((o) => o.id), "HEADWEAR");
  });

  test("every hairstyle's three pieces", () => {
    check("hair/base", HAIRSTYLES.flatMap((h) => h.base ?? []), "HAIRSTYLES.base");
    check("hair/front", HAIRSTYLES.flatMap((h) => h.front ?? []), "HAIRSTYLES.front");
    check("hair/back", HAIRSTYLES.flatMap((h) => h.back ?? []), "HAIRSTYLES.back");
  });

  test("no list offers the same thing twice, or nothing at all", () => {
    const lists = { BODIES, OUTFITS, EYES, BROWS, NOSES, MOUTHS, BEARDS, EYEWEAR, NECKWEAR, EARS, HORNS, HEADWEAR };
    for (const [name, list] of Object.entries(lists)) {
      expect(list.length, name).toBeGreaterThan(0);
      expect(new Set(list.map((o) => o.id)).size, name).toBe(list.length);
      expect(new Set(list.map((o) => o.label)).size, name).toBe(list.length);
    }
    expect(new Set(HAIRSTYLES.map((h) => h.id)).size).toBe(HAIRSTYLES.length);
    expect(new Set(HAIRSTYLES.map((h) => h.label)).size).toBe(HAIRSTYLES.length);
  });

  test("a cap is never crossed with a stranger's fringe", () => {
    // `hair/base/female02.png` and `hair/front/female02.png` are two halves of
    // one drawing. The only fronts that may sit on a cap not drawn for them
    // are the four `ear_cover` sideburns, which never touch the hairline.
    for (const h of HAIRSTYLES) {
      if (!h.front || h.front.startsWith("ear_cover")) continue;
      if (h.id === "ponytail") continue; // ponytail01 has no fringe of its own; female05's was drawn loose
      expect(h.front, h.id).toBe(h.base!);
    }
  });

  test("the default face is one of the things on offer", () => {
    // The picker highlights the current choice by id. A default that is not in
    // its own list is a picker that opens with nothing selected.
    expect(BODIES.some((o) => o.id === DEFAULT_COSMETIC.body)).toBe(true);
    expect(HAIRSTYLES.some((h) => h.id === DEFAULT_COSMETIC.hair)).toBe(true);
    expect(OUTFITS.some((o) => o.id === DEFAULT_COSMETIC.outfit)).toBe(true);
    expect(EYES.some((o) => o.id === DEFAULT_COSMETIC.eyes)).toBe(true);
    expect(EYEWEAR.some((o) => o.id === DEFAULT_COSMETIC.eyewear)).toBe(true);
  });
});

/* ------------------------------------------------------------------ order */

/** A step's identity: slot, variant, and which choice fills it when the
 *  slot serves two (hair/base is the cap AND the headwear). */
const key = (s: Step) => `${s.slot}:${s.variant}${s.part ? `:${s.part}` : ""}`;

describe("the composite order", () => {
  test("back to front, and the three placements that were got wrong first", () => {
    const slots = ORDER.map(key);
    const at = (k: string) => slots.indexOf(k);

    // Hair behind the head, then the head, then everything worn, then the face.
    expect(at("hair/back:base")).toBeLessThan(at("body:base"));
    expect(at("body:base")).toBeLessThan(at("cloths:primary"));

    // NECK AFTER CLOTHS. The five neck files are a tie, a bow, a scarf, a
    // necklace and a collar — all worn OVER the shirt. Under it they render as
    // literally nothing, which is what the first pass did.
    expect(at("neck:base")).toBeGreaterThan(at("cloths:primary"));

    // The face reads over the collar, and the brows over the eyes.
    expect(at("eyes:base")).toBeGreaterThan(at("neck:base"));
    expect(at("brows:base")).toBeGreaterThan(at("eyes:base"));

    // Hair over the face, glasses over the hair, the lens glint last of all.
    expect(at("hair/base:base")).toBeGreaterThan(at("brows:base"));
    expect(at("hair/front:base")).toBeGreaterThan(at("hair/base:base"));

    // EARS AFTER HAIR. Every file in `ears/` is an animal ear growing out of
    // the top of the head, not the human ear the body already draws. Behind
    // the hair cap three of the five were pixel-identical to no ears at all.
    expect(at("ears:base")).toBeGreaterThan(at("hair/front:base"));
    expect(at("ears:skin")).toBeGreaterThan(at("ears:base"));

    // Horns and headwear sit on top of the head, over the hair, with the ears.
    expect(at("horns:base")).toBeGreaterThan(at("hair/front:base"));
    expect(at("hair/base:base:headwear")).toBeGreaterThan(at("hair/front:base"));

    expect(at("glasses:base")).toBeGreaterThan(at("ears:base"));
    expect(at("glasses:reflection")).toBe(slots.length - 1);
  });

  test("every cast shadow is painted immediately before the thing that casts it", () => {
    // The other way round draws the shadow on top of the hair throwing it.
    ORDER.forEach((step, i) => {
      if (step.variant !== "shadow") return;
      const next = ORDER[i + 1];
      expect(next?.slot, `${step.slot} shadow`).toBe(step.slot);
      expect(step.material).toBe("cast");
    });
  });

  test("nothing is painted twice and no slot is forgotten", () => {
    const keys = ORDER.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    const covered = new Set(ORDER.map((s) => s.slot));
    expect(SLOTS.filter((s) => !covered.has(s))).toEqual([]);
  });
});

describe("personaPlan", () => {
  test("the default face plans a body, a face, clothes and hair, in order", () => {
    const plan = personaPlan(DEFAULT_COSMETIC);
    const keys = plan.map(key);
    expect(keys).toEqual(ORDER.filter((s) => keys.includes(key(s))).map(key));
    expect(plan.some((l) => l.slot === "body")).toBe(true);
    expect(plan.some((l) => l.slot === "eyes" && l.variant === "base")).toBe(true);
    expect(plan.some((l) => l.slot === "hair/base" && l.variant === "base")).toBe(true);
  });

  test("what is switched off is not planned", () => {
    const bare = personaPlan({
      ...DEFAULT_COSMETIC,
      beard: null,
      eyewear: null,
      neckwear: null,
      ears: null,
      horns: null,
      headwear: null,
      hairDecoration: false,
    });
    for (const slot of ["beard", "glasses", "neck", "ears", "horns"]) {
      expect(bare.some((l) => l.slot === slot), slot).toBe(false);
    }
    expect(bare.some((l) => l.variant === "decoration")).toBe(false);
    expect(bare.some((l) => l.part === "headwear")).toBe(false);
  });

  test("headwear is the hair/base slot painted a second time, in what it is made of", () => {
    const plan = personaPlan({ ...DEFAULT_COSMETIC, headwear: "ribbon" });
    const caps = plan.filter((l) => l.slot === "hair/base" && l.variant === "base");
    expect(caps.map((l) => l.id)).toEqual(["male01", "ribbon"]);
    // A ribbon is cloth; tinted as the step's steel it would be a strip of tin.
    expect(caps[1]!.material).toBe("cloth3");
    expect(personaPlan({ ...DEFAULT_COSMETIC, headwear: "headset" }).find((l) => l.part === "headwear")!.material).toBe("metal");
    // And it draws on a bald head, where there is no cap to share the slot with.
    const bald = personaPlan({ ...DEFAULT_COSMETIC, hair: "bald", headwear: "headset" });
    expect(bald.filter((l) => l.slot === "hair/base").map((l) => l.id)).toEqual(["headset"]);
  });

  test("a hairstyle with no back or fringe plans neither", () => {
    // `crop` is base-only. Planning a `hair/back` for it would look up a file
    // that does not exist and quietly do nothing — but it would also mean the
    // plan no longer describes what gets drawn.
    const plan = personaPlan({ ...DEFAULT_COSMETIC, hair: "crop" });
    expect(plan.some((l) => l.slot === "hair/back")).toBe(false);
    expect(plan.filter((l) => l.slot === "hair/front").length).toBeGreaterThan(0);
  });

  test("every id a plan names is a file on disk", () => {
    // The end-to-end version of the curation check: walk every offered choice
    // through the planner and confirm the base layer of each resolves.
    const misses: string[] = [];
    for (const body of BODIES) {
      for (const hair of HAIRSTYLES) {
        for (const outfit of OUTFITS) {
          const cos = { ...DEFAULT_COSMETIC, body: body.id, hair: hair.id, outfit: outfit.id };
          for (const l of personaPlan(cos)) {
            if (l.variant !== "base" && l.variant !== "primary") continue;
            if (!CAT[l.slot].has(l.id)) misses.push(`${l.slot}/${l.id}`);
          }
        }
      }
    }
    expect([...new Set(misses)].join(", ") || null).toBeNull();
  });
});

/* --------------------------------------------------------------- swatches */

describe("the swatches", () => {
  test("every kind has unique ids and labels, and a hex for every tone", () => {
    const hex = /^#[0-9a-f]{6}$/;
    for (const [kind, list] of Object.entries(SWATCHES)) {
      expect(list.length, kind).toBeGreaterThan(0);
      expect(new Set(list.map((s) => s.id)).size, kind).toBe(list.length);
      expect(new Set(list.map((s) => s.label)).size, kind).toBe(list.length);
      for (const s of list) {
        for (const t of [s.tones.light, s.tones.dark, s.tones.shadow]) expect(t, `${kind}/${s.id}`).toMatch(hex);
        // The chip a picker paints. Natural lips have none of their own — they take the skin's.
        if (s.id !== NATURAL_LIPS) expect(s.chip, `${kind}/${s.id}`).toMatch(hex);
      }
    }
  });

  test("the default face is Endesga 32, byte for byte", () => {
    // The palette the art was drawn against. The skin swatch is the E32 ramp
    // the old single-mid ramp produced from #b86f50, so choosing skin changed
    // nothing about the default portrait.
    expect(swatch("skin", "light").tones).toEqual({ light: "#ead4aa", dark: "#b86f50", shadow: "#733e39" });
    expect(swatch("iris", "blue").chip).toBe("#0099db");
    expect(swatch("cloth", "navy").chip).toBe("#3a4466");
    expect(swatch("cloth", "yellow").chip).toBe("#feae34");
  });

  test("an unknown id paints the first of its kind, never nothing", () => {
    expect(swatch("skin", "no-such-skin")).toBe(SWATCHES.skin[0]!);
  });

  test("skin goes from light to deep and stays skin-coloured all the way down", () => {
    // The reason skin is three explicit tones and not a ramp: the ramp's
    // highlight rung drops saturation to 0.484, which turned every darker
    // skin ashy. So every swatch's face tone must be warm (hue in the
    // orange band) and no less saturated than a third.
    const hsv = (h: string) => {
      const r = parseInt(h.slice(1, 3), 16) / 255, g = parseInt(h.slice(3, 5), 16) / 255, b = parseInt(h.slice(5, 7), 16) / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      const hue = d === 0 ? 0 : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
      return { h: (hue + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
    };
    let lastV = 2;
    for (const s of SWATCHES.skin) {
      const { h, s: sat, v } = hsv(s.tones.light);
      expect(h, s.id).toBeGreaterThanOrEqual(15);
      expect(h, s.id).toBeLessThanOrEqual(40);
      expect(sat, s.id).toBeGreaterThanOrEqual(0.15);
      expect(v, s.id).toBeLessThan(lastV);   // ordered light to deep
      lastV = v;
    }
  });

  test("natural lips are the skin's shade; a worn colour is its own", () => {
    const skin = swatch("skin", "deep").tones;
    expect(lipTones(NATURAL_LIPS, skin)).toEqual({ light: skin.dark, dark: skin.shadow, shadow: skin.shadow });
    expect(lipTones("red", skin)).toEqual(swatch("lips", "red").tones);
  });

  test("a cast shadow is one flat tone of the skin's shade", () => {
    const skin = swatch("skin", "light").tones;
    const c = castTones(skin);
    expect(c.light).toBe(c.dark);
    expect(c.dark).toBe(skin.dark);
  });
});

/* ---------------------------------------------------------------- presets */

describe("the presets", () => {
  test("every preset names only things on offer", () => {
    for (const p of PRESETS) {
      const c = applyPreset(p);
      // A round trip through the validator changes nothing — which is the
      // same as saying every id in it exists.
      expect(validateCosmetic(c), p.id).toEqual(c);
    }
  });

  test("they are not twelve of the same person", () => {
    const skins = new Set(PRESETS.map((p) => applyPreset(p).colors.skin));
    const hairs = new Set(PRESETS.map((p) => applyPreset(p).hair));
    expect(skins.size).toBeGreaterThanOrEqual(8);
    expect(hairs.size).toBeGreaterThanOrEqual(10);
  });
});

/* ------------------------------------------------------------------ store */

describe("validateCosmetic", () => {
  test("a stored id the art no longer has falls back to the default for that slot", () => {
    const c = validateCosmetic({ hair: "mullet", body: "female02", colors: { skin: "martian", hair: "ginger" } });
    expect(c.hair).toBe(DEFAULT_COSMETIC.hair);
    expect(c.body).toBe("female02");
    expect(c.colors.skin).toBe(DEFAULT_COSMETIC.colors.skin);
    expect(c.colors.hair).toBe("ginger");
  });

  test("garbage is the default face; an empty choice is a bare one", () => {
    expect(validateCosmetic(null)).toEqual(DEFAULT_COSMETIC);
    expect(validateCosmetic("x")).toEqual(DEFAULT_COSMETIC);
    // An object is a choice, and an optional slot it does not mention is
    // "none" — the same reading the first version gave a stored choice.
    const bare = validateCosmetic({ colors: 7 });
    expect(bare.colors).toEqual(DEFAULT_COSMETIC.colors);
    expect(bare.eyewear).toBeNull();
    expect(bare.body).toBe(DEFAULT_COSMETIC.body);
  });

  test("the old stored shape — no colours — still loads, in the default palette", () => {
    // The first version stored the choice without colours. It must not
    // come back as a different face.
    const c = validateCosmetic({ body: "male03", hair: "undercut", outfit: "male07", eyes: "male03", brows: "flat01",
      nose: "small01", mouth: "grin01", beard: "beard01", eyewear: null, neckwear: null, ears: null, hairDecoration: false });
    expect(c.hair).toBe("undercut");
    expect(c.colors).toEqual(DEFAULT_COSMETIC.colors);
    expect(c.horns).toBeNull();
    expect(c.headwear).toBeNull();
  });
});
