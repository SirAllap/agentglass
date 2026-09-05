/*
 * The colours a portrait can be — every skin, every hair, every eye, every
 * garment the editor offers, as data.
 *
 * These hexes are ART, not theme tokens (see the note on DEFAULT_PALETTE in
 * parts.ts, and web/test/understudy-panel-tokens.test.ts, which excludes this
 * folder by name). They are the colours a person is, and a person does not
 * change colour when the wall behind them is repainted.
 *
 * TWO KINDS OF SWATCH, AND WHY.
 *
 * Hair, eyes, lips, cloth and metal are one mid tone each, and `ramp()` in
 * shader.ts derives the rest — that ramp is fitted to Endesga 32 and it does
 * what a pixel artist does: shadows roll toward purple, highlights toward
 * yellow, saturation peaks in the middle. For those materials it is right.
 *
 * Skin is written out in full — three tones per swatch — because the ramp is
 * NOT right for it past a tan, and this was rendered and looked at rather
 * than reasoned about. The face is painted with the ramp's HIGHLIGHT rung
 * (the masks fill the broad areas with green, which is the light tone), and
 * that rung multiplies saturation by 0.484. Fed a light mid that lands on
 * E32's peach exactly; fed a deep brown it lands on grey-olive, and a whole
 * ladder of darker skins came out ashy, each one more than the last. A deep
 * skin in pixel art keeps its saturation in the light and goes cooler only in
 * the deepest shadow, and no single multiplier does both ends. So the eleven
 * skins are three hand-picked tones each: `light` is the colour of the face,
 * `dark` is the shade on the side of the nose, `shadow` is under the jaw.
 *
 * Black hair is the one hair written out too, for the mirror reason: the
 * ramp's highlight rung is 1.27× the mid, and 1.27× nearly-black is still
 * nearly black, so the crop lost its shape against a dark ground. Black hair
 * in pixel art is lit by the sky — its highlight is a desaturated blue.
 */
import { material, type Tones } from "./shader.ts";

export interface Swatch {
  id: string;
  label: string;
  /** The three tones the shader paints with: light (the broad area), dark
   *  (the shade), shadow (the deepest). */
  tones: Tones;
  /** The one colour to draw this swatch as, in a picker. The light tone for
   *  skin (it is what the face is), the mid for everything else. */
  chip: string;
}

/** A swatch from one mid tone, through the fitted ramp. */
function derived(id: string, label: string, mid: string, cool = false): Swatch {
  return { id, label, tones: material(mid, cool), chip: mid };
}

/** A swatch written out in full. */
function explicit(id: string, label: string, light: string, dark: string, shadow: string): Swatch {
  return { id, label, tones: { light, dark, shadow }, chip: light };
}

/* ------------------------------------------------------------------- skin */

/**
 * Eleven, light to deep. `light` is the light of Endesga 32's skin ramp and
 * the tones are that ramp exactly, which keeps the default face byte-for-byte
 * what it was before skin could be chosen.
 */
export const SKINS: readonly Swatch[] = [
  explicit("porcelain", "Porcelain", "#fbe6d4", "#e8b89a", "#b97f67"),
  explicit("fair", "Fair", "#f4d6b5", "#dba77e", "#a8704f"),
  explicit("light", "Light", "#ead4aa", "#b86f50", "#733e39"),
  explicit("peach", "Peach", "#e9c19a", "#c68a5c", "#8a5638"),
  explicit("olive", "Olive", "#d9b48a", "#b1825a", "#7a5436"),
  explicit("tan", "Tan", "#cf9b6a", "#a6704a", "#6e472f"),
  explicit("bronze", "Bronze", "#b8814f", "#8d5a36", "#5c3820"),
  explicit("brown", "Brown", "#9c6540", "#74462a", "#4a2b18"),
  explicit("chestnut", "Chestnut", "#7e4d2e", "#5c351f", "#3a2013"),
  explicit("deep", "Deep", "#5e3a24", "#432818", "#2a180e"),
  explicit("ebony", "Ebony", "#46291a", "#301b10", "#1d1009"),
];

/* ------------------------------------------------------------------- hair */

/**
 * Natural shades first, in the order they sit on a colour chart, then grey
 * and white, then the dyed ones. `cool` on the dark and the cold ones: a
 * navy shaded the warm way turns teal in its folds (see COOL in parts.ts).
 */
export const HAIRS: readonly Swatch[] = [
  explicit("black", "Black", "#3a3650", "#1c1a24", "#0e0d14"),
  derived("espresso", "Espresso", "#2e2226", true),
  derived("darkbrown", "Dark brown", "#4a2f27"),
  derived("brown", "Brown", "#733e39"),
  derived("chestnut", "Chestnut", "#8a4f3a"),
  derived("auburn", "Auburn", "#a0452e"),
  derived("ginger", "Ginger", "#c9652a"),
  derived("copper", "Copper", "#d58a5a"),
  derived("darkblonde", "Dark blonde", "#a88650"),
  derived("blonde", "Blonde", "#d9b36e"),
  derived("platinum", "Platinum", "#e9dcc0"),
  derived("grey", "Grey", "#8d8a90", true),
  derived("white", "White", "#e8e6ea", true),
  derived("pink", "Pink", "#e06b9a"),
  derived("red", "Red", "#c42d3c"),
  derived("purple", "Purple", "#7a4ab8", true),
  derived("blue", "Blue", "#3b6fd0", true),
  derived("teal", "Teal", "#2a9d9a", true),
  derived("green", "Green", "#3f9a4a", true),
];

/* ------------------------------------------------------------------- eyes */

/** The iris. Brown first because most eyes are. E32's blue keeps the default. */
export const IRISES: readonly Swatch[] = [
  derived("darkbrown", "Dark brown", "#4a2c1c", true),
  derived("brown", "Brown", "#7a4a2e", true),
  derived("hazel", "Hazel", "#8f7434", true),
  derived("amber", "Amber", "#c48a2a", true),
  derived("green", "Green", "#3f8a4a", true),
  derived("blue", "Blue", "#0099db", true),
  derived("grey", "Grey", "#7a8aa0", true),
  derived("violet", "Violet", "#7a5ab8", true),
  derived("black", "Black", "#2a2430", true),
  derived("red", "Red", "#c42d3c", true),
];

/* ------------------------------------------------------------------- lips */

/**
 * "Natural" is not a colour on this list: it is the skin's own shade, and it
 * is resolved from whatever skin is chosen — see `lipTones`. The rest are
 * worn colours.
 */
export const NATURAL_LIPS = "natural";

export const LIPS: readonly Swatch[] = [
  { id: NATURAL_LIPS, label: "Natural", tones: material("#a22633"), chip: "" },
  derived("rose", "Rose", "#c4566a"),
  derived("red", "Red", "#a22633"),
  derived("coral", "Coral", "#e0694a"),
  derived("berry", "Berry", "#8a2a4a"),
  derived("plum", "Plum", "#5a2a4a", true),
  derived("nude", "Nude", "#b8826a"),
];

/* ------------------------------------------------------------------ cloth */

/**
 * One list for all three cloth layers and the accent, because a jacket's
 * lining wants the same choices as its shell.
 */
export const CLOTHS: readonly Swatch[] = [
  derived("navy", "Navy", "#3a4466", true),
  derived("slate", "Slate", "#5a6988", true),
  derived("charcoal", "Charcoal", "#262b44", true),
  derived("black", "Black", "#181425", true),
  derived("steel", "Steel", "#8b9bb4", true),
  derived("white", "White", "#e8e0d0", true),
  derived("cream", "Cream", "#d4b89a"),
  derived("tan", "Tan", "#b86f50"),
  derived("brown", "Brown", "#733e39"),
  derived("red", "Red", "#a22633"),
  derived("burgundy", "Burgundy", "#7a1f3a"),
  derived("orange", "Orange", "#f77622"),
  derived("yellow", "Yellow", "#feae34"),
  derived("green", "Green", "#3e8948", true),
  derived("forest", "Forest", "#265c42", true),
  derived("teal", "Teal", "#1f8a8a", true),
  derived("blue", "Blue", "#124e89", true),
  derived("sky", "Sky", "#0099db", true),
  derived("purple", "Purple", "#68386c", true),
  derived("pink", "Pink", "#f6757a"),
];

/* ------------------------------------------------------------------ metal */

export const METALS: readonly Swatch[] = [
  derived("steel", "Steel", "#8b9bb4", true),
  derived("gold", "Gold", "#feae34"),
  derived("black", "Black", "#262b44", true),
  derived("copper", "Copper", "#c9652a"),
  derived("white", "White", "#e8e6ea", true),
];

/* ----------------------------------------------------------- the neutral */

/**
 * The shader's neutral path for an eye: pupil and sclera. Not offered — they
 * are the same for everybody, which is what the neutral path is for.
 */
export const PUPIL = "#181425";
export const SCLERA = "#ffffff";

/* ---------------------------------------------------------------- lookup */

export const SWATCHES = {
  skin: SKINS,
  hair: HAIRS,
  iris: IRISES,
  lips: LIPS,
  cloth: CLOTHS,
  metal: METALS,
} as const;

export type SwatchKind = keyof typeof SWATCHES;

/** The swatch for an id, or the first of its kind when the id is unknown —
 *  a stored id from a build that renamed one must still paint a face. */
export function swatch(kind: SwatchKind, id: string): Swatch {
  const list = SWATCHES[kind];
  return list.find((s) => s.id === id) ?? list[0]!;
}

/**
 * The lip tones for a choice, given the skin they sit on.
 *
 * Natural lips are the skin's shade and its shadow — darker than the face,
 * the same hue as it. Offering "natural" as a fixed pink was the first
 * version, and on a deep skin a fixed pink is lipstick.
 */
export function lipTones(lips: string, skin: Tones): Tones {
  if (lips === NATURAL_LIPS) return { light: skin.dark, dark: skin.shadow, shadow: skin.shadow };
  return swatch("lips", lips).tones;
}

/**
 * The tones for a `_shadow.png` — the shadow one layer casts on the face.
 *
 * Every one of those masks is flat #808000, which the shader resolves to the
 * midpoint of `dark` and `light`, so both are the skin's shade and the mask
 * comes out one flat tone. The shade and not the deepest shadow: the deepest
 * is already what the art paints under the jaw, and a cast shadow landing on
 * it has nowhere darker to go.
 */
export function castTones(skin: Tones): Tones {
  return { light: skin.dark, dark: skin.dark, shadow: skin.shadow };
}
