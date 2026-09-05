/*
 * What the persona is made of, and the order the pieces go down in.
 *
 * Two separate jobs live here, and neither of them touches the filesystem or
 * Vite:
 *
 *   1. The GRAMMAR of the vendored art — which directories are slots, which
 *      filename suffixes are variants of an option rather than options of
 *      their own, and which layer is painted with which material.
 *   2. The CURATION — what each slot offers, with a name a person would use.
 *      There are 295 files down there and the editor offers nearly all of
 *      them, but as OPTIONS rather than files: a hairstyle is a cap, a fringe
 *      and a back that were drawn for each other, and `glasses01` is one pair
 *      of glasses drawn in four passes. The few left out are named, with the
 *      picture that decided it.
 *
 * It is a plain data module on purpose. `layers.ts` needs Vite's
 * `import.meta.glob` to find the PNGs and therefore cannot be imported by
 * `bun test`, so everything a test has to reach — the parse rule, the composite
 * order, the curated ids — is kept on this side of that line.
 */

/* ------------------------------------------------------------------- slots */

/**
 * A slot IS its directory under `layers/`, path and all.
 *
 * Hair is three directories rather than one because the three sit at different
 * depths of the stack: the back falls behind the head, the base is the skull
 * cap over the ears, and the front is the fringe that crosses the face. One
 * "hair" slot could not be ordered correctly against the eyes.
 */
export const SLOTS = [
  "hair/back",
  "body",
  "ears",
  "horns",
  "cloths",
  "neck",
  "mouth",
  "nose",
  "eyes",
  "brows",
  "beard",
  "hair/base",
  "hair/front",
  "glasses",
] as const;

export type Slot = (typeof SLOTS)[number];

/**
 * The filename suffixes that mean "another piece of the same option".
 *
 * `glasses01.png`, `glasses01_shadow.png`, `glasses01_reflection.png` and
 * `glasses01_reflection_shadow.png` are ONE pair of glasses, not four. Listing
 * them as four options is the obvious bug here, and it is worse than it looks:
 * a `_shadow` alone is a bare grey smear with no object casting it.
 *
 * Order matters — longest first. `_reflection_shadow` has to be tried before
 * `_shadow`, or the id comes out as "glasses01_reflection" and the catalogue
 * grows a phantom option that resolves to no base file.
 */
export const VARIANT_SUFFIX = {
  "reflection-shadow": "_reflection_shadow",
  decoration: "_decoration01",
  reflection: "_reflection",
  secondary: "_secondary",
  primary: "_primary",
  details: "_details",
  shadow: "_shadow",
  fluff: "_fluff",
  skin: "_skin",
  base: "",
} as const;

export type Variant = keyof typeof VARIANT_SUFFIX;

/** Longest suffix first; `base` is the empty string and must be tried last. */
const SUFFIXES = (Object.keys(VARIANT_SUFFIX) as Variant[]).sort(
  (a, b) => VARIANT_SUFFIX[b].length - VARIANT_SUFFIX[a].length,
);

/**
 * Split a bare filename (no directory, no `.png`) into the option it belongs to
 * and which piece of it it is.
 *
 * `"female01_secondary"` -> `{ id: "female01", variant: "secondary" }`
 * `"eye_patch01_left"`   -> `{ id: "eye_patch01_left", variant: "base" }`
 */
export function splitLayerFile(name: string): { id: string; variant: Variant } {
  for (const variant of SUFFIXES) {
    const suffix = VARIANT_SUFFIX[variant];
    if (suffix && name.endsWith(suffix)) return { id: name.slice(0, -suffix.length), variant };
  }
  return { id: name, variant: "base" };
}

/* --------------------------------------------------------------- materials */

/**
 * The colours a portrait is built from. One mid tone each; `shader.ts` derives
 * the other four rungs.
 *
 * `cast` is not a colour the user picks. It is the skin's ramp, used to tint
 * every `_shadow.png` — the shadow a layer throws onto the face below it.
 */
export type Material =
  | "skin"
  | "hair"
  | "iris"
  | "lips"
  | "cloth1"
  | "cloth2"
  | "cloth3"
  | "metal"
  | "cast";

/**
 * Which materials rotate their hue the cool way (see `ramp` in shader.ts).
 *
 * Skin, hair and lips are lit warm. Fabric and steel are not: a navy jacket
 * shaded the warm way turns teal in its folds, which reads as a second
 * garment.
 */
export const COOL: Readonly<Record<Material, boolean>> = {
  skin: false,
  hair: false,
  lips: false,
  cast: false,
  iris: true,
  cloth1: true,
  cloth2: true,
  cloth3: true,
  metal: true,
};

/* ------------------------------------------------------------------- order */

export interface Step {
  slot: Slot;
  variant: Variant;
  material: Material;
  /**
   * Which choice fills this step, when the slot serves more than one.
   *
   * `hair/base` is two things in the source art: the seventy-two hair caps,
   * and three objects that are not hair at all — `headset`, `earrings` and
   * `ribbon` — drawn into that directory because they sit at that depth of
   * the stack. One step per (slot, variant) cannot paint both a cap and a
   * headset, so the headwear step names itself and `personaPlan` fills it
   * from the headwear choice instead of the hairstyle.
   */
  part?: "headwear";
}

/**
 * The composite, back to front. Rendered and looked at, not reasoned about.
 *
 * Four of these placements were only settled by putting portraits on a dark
 * ground at 192px and reading them, and two of the four were specified the
 * other way round first:
 *
 *   - NECK GOES AFTER CLOTHS. It was specified before, on the reasoning that
 *     `neck/` is the collar of the garment. It is not: the five files are a
 *     tie, a bow, a scarf, a necklace and a collar, all of which are worn OVER
 *     the shirt. Composited under it they vanished completely — the tie and the
 *     scarf rendered as nothing at all, which is a bug you cannot see in a
 *     diff and cannot miss in a picture.
 *   - EARS GO AFTER HAIR. Also specified before, beside the body, which is
 *     where a human ear belongs — but every file in `ears/` is an ANIMAL ear
 *     growing out of the top of the head. The hair cap covers rows 4 to 47 and
 *     the ears are drawn between rows 0 and 25, so underneath it the bunny
 *     ears kept three of their twenty-two rows and the bear ears none of their
 *     eleven. Above the fringe instead, four of the five read clearly; why the
 *     fifth is not offered is in the comment on EARS.
 *   - EACH `_shadow` IMMEDIATELY BEFORE THE THING THAT CASTS IT. A cast shadow
 *     has to land on everything already painted and then be covered by its own
 *     caster, so the pair is always (shadow, object) and never (object,
 *     shadow), which would draw the shadow on top of the hair that throws it.
 *   - GLASSES LAST, REFLECTION LAST OF ALL. The frame sits over the eyes and
 *     the lens glint sits over the frame. Anything after them draws through
 *     the lens.
 *
 * `_reflection_shadow` is absent deliberately: all four are byte-identical to
 * the plain `_shadow` of the same option (checked with `cmp`), so drawing both
 * would stamp the same grey twice for nothing.
 *
 * Horns and headwear go with the ears: things that grow from, or sit on, the
 * top of the head, over the hair. The headwear step is the `hair/base` slot
 * painted a second time with a different choice in it — see `Step.part`.
 */
export const ORDER: readonly Step[] = [
  { slot: "hair/back", variant: "base", material: "hair" },
  { slot: "body", variant: "base", material: "skin" },
  { slot: "cloths", variant: "shadow", material: "cast" },
  { slot: "cloths", variant: "primary", material: "cloth1" },
  { slot: "cloths", variant: "secondary", material: "cloth2" },
  { slot: "cloths", variant: "details", material: "cloth3" },
  { slot: "neck", variant: "base", material: "cloth3" },
  { slot: "mouth", variant: "base", material: "lips" },
  { slot: "nose", variant: "base", material: "skin" },
  { slot: "eyes", variant: "shadow", material: "cast" },
  { slot: "eyes", variant: "base", material: "iris" },
  { slot: "brows", variant: "base", material: "hair" },
  { slot: "beard", variant: "shadow", material: "cast" },
  { slot: "beard", variant: "base", material: "hair" },
  { slot: "hair/base", variant: "shadow", material: "cast" },
  { slot: "hair/base", variant: "base", material: "hair" },
  { slot: "hair/base", variant: "decoration", material: "cloth3" },
  { slot: "hair/front", variant: "shadow", material: "cast" },
  { slot: "hair/front", variant: "base", material: "hair" },
  { slot: "horns", variant: "base", material: "metal" },
  { slot: "ears", variant: "base", material: "hair" },
  { slot: "ears", variant: "skin", material: "skin" },
  { slot: "ears", variant: "fluff", material: "hair" },
  { slot: "hair/base", variant: "base", material: "metal", part: "headwear" },
  { slot: "glasses", variant: "shadow", material: "cast" },
  { slot: "glasses", variant: "base", material: "metal" },
  { slot: "glasses", variant: "reflection", material: "metal" },
];

/* ----------------------------------------------------------- the curation */

export interface Option {
  id: string;
  label: string;
}

/**
 * An option that is painted with a material of its own rather than the
 * step's. A ribbon is cloth; a headset is not.
 */
export interface MadeOf extends Option {
  material: Material;
}

/** A hairstyle is up to three ids at once, which is why it is not one list. */
export interface Hairstyle {
  id: string;
  label: string;
  /**
   * The skull cap.
   *
   * Optional, because a shaved head is a hairstyle and the honest way to draw
   * one is to draw nothing — not to ship a file of transparent pixels so that
   * this field can stay required.
   */
  base?: string;
  /** The fringe that crosses the face. */
  front?: string;
  /** What falls behind the head and shoulders. */
  back?: string;
}

/**
 * The eight heads. The art names them `male`/`female`, and the labels do not:
 * what the files actually differ in is the jaw and the set of the shoulders,
 * and a jaw is not a gender. Rendered bald and side by side the three in each
 * set are square, broad and lean; the other three are round, oval and narrow.
 * The two androids carry seam lines and are the same heads otherwise.
 */
export const BODIES: readonly Option[] = [
  { id: "male01", label: "Square" },
  { id: "male02", label: "Broad" },
  { id: "male03", label: "Lean" },
  { id: "female01", label: "Round" },
  { id: "female02", label: "Oval" },
  { id: "female03", label: "Narrow" },
  { id: "male_android", label: "Android" },
  { id: "female_android", label: "Android II" },
];

/**
 * Every style the art can make, and a few it can make only by crossing pieces.
 *
 * The first list offered sixteen and they read as one person with a hat
 * collection. What was sitting unused in the tree: cornrows, twists, a braided
 * crest, a braided updo, a short natural, a fade, four `ear_cover` fringes
 * that are sideburns, and eleven backs that only four styles wore. The backs are what turn a cap into
 * long hair, and they cross freely — `curly01` behind any cap is curls to the
 * shoulder — which is how "Curly" and "Long waves" exist at all.
 *
 * The pairing of a base with its OWN front is still by name and still not
 * decoration: `hair/base/female02.png` and `hair/front/female02.png` are two
 * halves of one drawing, and a cap with a stranger's fringe leaves a scalp-
 * shaped gap at the hairline. Where a front is borrowed below it is because
 * the cap has no fringe of its own (male04–10 are drawn swept back) and the
 * borrowed piece is a sideburn, which does not touch the hairline.
 *
 * "Bald" draws nothing and goes first: a shaved head is the plainest thing on
 * this list, not an afterthought at the end of it.
 */
export const HAIRSTYLES: readonly Hairstyle[] = [
  { id: "bald", label: "Bald" },
  { id: "fade", label: "Fade", base: "male05" },
  { id: "crop", label: "Crop", base: "male01", front: "male01" },
  { id: "short", label: "Short natural", base: "male06" },
  { id: "short-sides", label: "Short natural, sides", base: "male06", front: "ear_cover01" },
  { id: "sweptback", label: "Swept back", base: "male04" },
  { id: "sweptback-sides", label: "Swept back, sideburns", base: "male04", front: "ear_cover02" },
  { id: "slick", label: "Slicked", base: "male10" },
  { id: "slick-sides", label: "Slicked, long sides", base: "male10", front: "ear_cover04" },
  { id: "parted", label: "Side part", base: "male02", front: "male02" },
  { id: "undercut", label: "Undercut", base: "male03", front: "male03" },
  { id: "spiked", label: "Spiked", base: "male07" },
  { id: "cornrows", label: "Cornrows", base: "male08" },
  { id: "twists", label: "Twists", base: "male09" },
  { id: "braid-crest", label: "Braided crest", base: "female13" },
  { id: "braid-crest-long", label: "Braided crest, long", base: "female13", back: "medium03" },
  { id: "braid-updo", label: "Braided updo", base: "female14" },
  { id: "braid-updo-long", label: "Braided updo, long", base: "female14", back: "long01" },
  { id: "pixie", label: "Pixie", base: "female06", front: "female06" },
  { id: "bob", label: "Bob", base: "female01", front: "female01" },
  { id: "bob-full", label: "Bob, full", base: "female06", front: "female06", back: "short01" },
  { id: "cheek", label: "Cheek-length", base: "female03", front: "female03" },
  { id: "lob", label: "Lob", base: "female03", front: "female03", back: "medium01" },
  { id: "curly", label: "Curly", base: "female03", front: "female03", back: "curly01" },
  { id: "curly-short", label: "Curly, short", base: "male06", back: "curly01" },
  { id: "sideswept", label: "Side-swept", base: "female04", front: "female04" },
  { id: "sideswept-long", label: "Side-swept, long", base: "female10", front: "female10", back: "right01" },
  { id: "curtains", label: "Curtains", base: "female08", front: "female08", back: "medium02" },
  { id: "long", label: "Long", base: "female02", front: "female02", back: "long01" },
  { id: "long-waves", label: "Long waves", base: "female02", front: "female02", back: "long03" },
  { id: "centre-long", label: "Centre part, long", base: "female12", front: "female12", back: "long02" },
  { id: "topknot", label: "Top knot", base: "female07", front: "female07" },
  { id: "bun", label: "Side bun", base: "female09", front: "female09" },
  { id: "ponytail", label: "Ponytail", base: "ponytail01", front: "female05", back: "ponytail" },
  { id: "pigtails", label: "Pigtails", base: "female11", front: "female11", back: "pigtails01" },
];

/**
 * All twenty garments. The art's `male`/`female` prefixes are not in the
 * labels for the reason BODIES gives; every one of them fits every head,
 * which was checked by rendering the full grid, not assumed.
 */
export const OUTFITS: readonly Option[] = [
  { id: "male01", label: "Sweater" },
  { id: "male07", label: "T-shirt" },
  { id: "female09", label: "V-neck" },
  { id: "female08", label: "Turtleneck" },
  { id: "male02", label: "Henley" },
  { id: "male03", label: "Shirt" },
  { id: "male08", label: "Bolo shirt" },
  { id: "female10", label: "Cardigan" },
  { id: "male04", label: "Jacket" },
  { id: "female01", label: "Bomber" },
  { id: "male06", label: "Blazer" },
  { id: "female11", label: "Peacoat" },
  { id: "female02", label: "Trench" },
  { id: "male05", label: "Sash" },
  { id: "female12", label: "Pendant blouse" },
  { id: "female06", label: "Halter" },
  { id: "female05", label: "Camisole" },
  { id: "female03", label: "Off-shoulder" },
  { id: "female04", label: "Bardot" },
  { id: "female07", label: "Cold-shoulder" },
];

/**
 * Every eye shape, the four closed ones included. The shape of an eye is a
 * large part of what makes a face somebody's, and six shapes was the single
 * biggest reason every portrait read as the same person.
 */
export const EYES: readonly Option[] = [
  { id: "male01", label: "Level" },
  { id: "male02", label: "Hooded" },
  { id: "male03", label: "Narrow" },
  { id: "flat01", label: "Flat" },
  { id: "flat02", label: "Flat, soft" },
  { id: "angled01", label: "Angled" },
  { id: "female01", label: "Wide" },
  { id: "female02", label: "Almond" },
  { id: "female03", label: "Round" },
  { id: "tall01", label: "Tall" },
  { id: "closed01", label: "Closed" },
  { id: "closed02", label: "Closed, smiling" },
  { id: "closed03", label: "Closed, calm" },
  { id: "closed04", label: "Closed, wry" },
];

export const BROWS: readonly Option[] = [
  { id: "neutral01", label: "Level" },
  { id: "neutral02", label: "Soft" },
  { id: "neutral03", label: "Thin" },
  { id: "flat01", label: "Flat" },
  { id: "flat02", label: "Flat, heavy" },
  { id: "angry01", label: "Furrowed" },
  { id: "angry02", label: "Furrowed, heavy" },
  { id: "sad01", label: "Raised" },
  { id: "sad02", label: "Raised, soft" },
];

export const NOSES: readonly Option[] = [
  { id: "neutral01", label: "Straight" },
  { id: "neutral02", label: "Straight, long" },
  { id: "small01", label: "Small" },
  { id: "small02", label: "Button" },
  { id: "large01", label: "Large" },
  { id: "large02", label: "Broad" },
  { id: "pointy01", label: "Pointed" },
  { id: "pointy02", label: "Aquiline" },
];

export const MOUTHS: readonly Option[] = [
  { id: "neutral01", label: "Neutral" },
  { id: "neutral02", label: "Neutral, wide" },
  { id: "neutral", label: "Line" },
  { id: "small", label: "Small" },
  { id: "smile01", label: "Smile" },
  { id: "smile02", label: "Smile, wide" },
  { id: "grin01", label: "Grin" },
  { id: "grin02", label: "Grin, teeth" },
  { id: "sad01", label: "Downturned" },
  { id: "sad02", label: "Pout" },
  { id: "O", label: "Oh" },
];

/** `null` is the first entry everywhere something is optional. */
export const BEARDS: readonly Option[] = [
  { id: "beard01", label: "Stubble" },
  { id: "beard02", label: "Short" },
  { id: "beard03", label: "Chinstrap" },
  { id: "beard04", label: "Goatee" },
  { id: "beard05", label: "Full" },
  { id: "moustache", label: "Moustache" },
];

export const EYEWEAR: readonly Option[] = [
  { id: "glasses01", label: "Round" },
  { id: "glasses02", label: "Square" },
  { id: "glasses03", label: "Wide" },
  { id: "glasses04", label: "Half-rim" },
  { id: "monocle", label: "Monocle" },
  { id: "eye_patch01_left", label: "Eye patch" },
  { id: "eye_patch01_right", label: "Eye patch, right" },
  { id: "eye_patch02_left", label: "Visor patch" },
  { id: "eye_patch02_right", label: "Visor patch, right" },
];

export const NECKWEAR: readonly Option[] = [
  { id: "collar", label: "Collar" },
  { id: "tie", label: "Tie" },
  { id: "bow", label: "Bow" },
  { id: "scarf", label: "Scarf" },
  { id: "necklace", label: "Necklace" },
];

/**
 * Five of the six animal ears in the art, and why `dog_ears01` is not here.
 *
 * Dog ears are floppy: they hang at the sides of the head, inside the hair's
 * own silhouette, and they are tinted with the hair material because that is
 * what they are made of. Rendered at 192px against a control with no ears at
 * all, the two pictures were indistinguishable — an option that costs a click
 * and changes nothing. The other five break the outline of the head, which is
 * the whole point of putting them on.
 */
export const EARS: readonly Option[] = [
  { id: "cat_ears01", label: "Cat" },
  { id: "fox_ears01", label: "Fox" },
  { id: "fox_ears02", label: "Fox, tall" },
  { id: "bunny_ears01", label: "Bunny" },
  { id: "bear_ears01", label: "Bear" },
];

/** Painted with the metal material: horn is keratin, and keratin is lit like
 *  a polished thing, not like hair. */
export const HORNS: readonly Option[] = [
  { id: "short01", label: "Short" },
  { id: "long01", label: "Long" },
  { id: "dragon_horns01", label: "Dragon" },
  { id: "massive01", label: "Ram" },
];

/**
 * The three things in `hair/base/` that are not hair. Each says what it is
 * made of, because the step that paints them cannot know: a ribbon tinted as
 * steel is a strip of tin.
 */
export const HEADWEAR: readonly MadeOf[] = [
  { id: "headset", label: "Headset", material: "metal" },
  { id: "earrings", label: "Earrings", material: "metal" },
  { id: "ribbon", label: "Ribbon", material: "cloth3" },
];

/* -------------------------------------------------------------- cosmetics */

/**
 * The colours, by swatch id. The swatches themselves — and the hexes — live
 * in `swatches.ts`; this is a choice, not a colour.
 */
export interface Palette {
  skin: string;
  hair: string;
  iris: string;
  lips: string;
  cloth1: string;
  cloth2: string;
  cloth3: string;
  metal: string;
}

export interface Cosmetic {
  body: string;
  hair: string;
  outfit: string;
  eyes: string;
  brows: string;
  nose: string;
  mouth: string;
  beard: string | null;
  eyewear: string | null;
  neckwear: string | null;
  ears: string | null;
  horns: string | null;
  headwear: string | null;
  hairDecoration: boolean;
  colors: Palette;
}

/**
 * The default face: Endesga 32, the palette the layers were drawn against.
 * Every id here names a swatch whose tones are that palette's, so the default
 * portrait is the one the art was made for.
 */
export const DEFAULT_PALETTE: Palette = {
  skin: "light",
  hair: "brown",
  iris: "blue",
  lips: "natural",
  cloth1: "navy",
  cloth2: "slate",
  cloth3: "yellow",
  metal: "steel",
};

export const DEFAULT_COSMETIC: Cosmetic = {
  body: "male01",
  hair: "crop",
  outfit: "male01",
  eyes: "male01",
  brows: "neutral01",
  nose: "neutral01",
  mouth: "neutral01",
  beard: null,
  eyewear: "glasses01",
  neckwear: null,
  ears: null,
  horns: null,
  headwear: null,
  hairDecoration: false,
  colors: DEFAULT_PALETTE,
};

/* ---------------------------------------------------------------- presets */

/**
 * Somewhere to start from.
 *
 * Thirty hairstyles by eleven skins by nineteen hair colours is a space nobody
 * wants to walk one chip at a time, and the default face sits in one corner
 * of it. Each preset is a whole person picked to be far from the others, so
 * that the one nearest you is a few clicks from being you. They set
 * everything; what they do not name falls back to the default.
 */
export interface Preset {
  id: string;
  label: string;
  cos: Partial<Omit<Cosmetic, "colors">> & { colors?: Partial<Palette> };
}

export const PRESETS: readonly Preset[] = [
  { id: "default", label: "Default", cos: {} },
  { id: "amara", label: "Braids", cos: {
    body: "female02", hair: "braid-updo-long", outfit: "female09", eyes: "female02", brows: "neutral02", nose: "small02", mouth: "smile01", eyewear: null,
    colors: { skin: "deep", hair: "black", iris: "darkbrown", cloth1: "burgundy", cloth2: "cream", cloth3: "yellow", metal: "gold" } } },
  { id: "marcus", label: "Short natural", cos: {
    body: "male02", hair: "short", outfit: "male06", eyes: "male02", brows: "flat02", nose: "large02", mouth: "neutral02", beard: "beard02", eyewear: null,
    colors: { skin: "ebony", hair: "black", iris: "black", cloth1: "charcoal", cloth2: "white", cloth3: "steel", metal: "steel" } } },
  { id: "mei", label: "Bob", cos: {
    body: "female03", hair: "bob", outfit: "female08", eyes: "flat02", brows: "neutral03", nose: "small01", mouth: "small", eyewear: "glasses02",
    colors: { skin: "fair", hair: "black", iris: "darkbrown", cloth1: "black", cloth2: "slate", cloth3: "red", metal: "black" } } },
  { id: "diego", label: "Undercut", cos: {
    body: "male03", hair: "undercut", outfit: "male07", eyes: "male03", brows: "angry01", nose: "pointy02", mouth: "grin01", beard: "beard01", eyewear: null,
    colors: { skin: "tan", hair: "espresso", iris: "brown", cloth1: "forest", cloth2: "cream", cloth3: "orange", metal: "steel" } } },
  { id: "priya", label: "Long waves", cos: {
    body: "female01", hair: "long-waves", outfit: "female12", eyes: "female01", brows: "neutral01", nose: "neutral01", mouth: "smile02", eyewear: null, headwear: "earrings",
    colors: { skin: "bronze", hair: "darkbrown", iris: "darkbrown", lips: "berry", cloth1: "teal", cloth2: "purple", cloth3: "yellow", metal: "gold" } } },
  { id: "sven", label: "Silver", cos: {
    body: "male01", hair: "sweptback-sides", outfit: "male03", eyes: "male01", brows: "flat01", nose: "neutral02", mouth: "neutral01", beard: "beard05", eyewear: "glasses04",
    colors: { skin: "porcelain", hair: "grey", iris: "grey", cloth1: "slate", cloth2: "white", cloth3: "navy", metal: "steel" } } },
  { id: "sam", label: "Pixie", cos: {
    body: "female03", hair: "pixie", outfit: "female01", eyes: "angled01", brows: "neutral02", nose: "small01", mouth: "grin02", eyewear: null, headwear: "headset",
    colors: { skin: "olive", hair: "pink", iris: "green", cloth1: "black", cloth2: "charcoal", cloth3: "pink", metal: "black" } } },
  { id: "yusuf", label: "Cornrows", cos: {
    body: "male02", hair: "cornrows", outfit: "male02", eyes: "male01", brows: "neutral01", nose: "large01", mouth: "smile01", beard: "beard04", eyewear: null,
    colors: { skin: "chestnut", hair: "black", iris: "darkbrown", cloth1: "sky", cloth2: "navy", cloth3: "white", metal: "gold" } } },
  { id: "ines", label: "Curly", cos: {
    body: "female02", hair: "curly", outfit: "female10", eyes: "female03", brows: "sad02", nose: "neutral01", mouth: "neutral01", eyewear: "glasses01",
    colors: { skin: "peach", hair: "auburn", iris: "hazel", lips: "rose", cloth1: "cream", cloth2: "brown", cloth3: "forest", metal: "copper" } } },
  { id: "ren", label: "Top knot", cos: {
    body: "male03", hair: "topknot", outfit: "male05", eyes: "flat01", brows: "flat01", nose: "neutral01", mouth: "neutral", beard: "moustache", eyewear: null,
    colors: { skin: "light", hair: "espresso", iris: "black", cloth1: "navy", cloth2: "red", cloth3: "yellow", metal: "gold" } } },
  { id: "kit", label: "Fox", cos: {
    body: "female01", hair: "sideswept-long", outfit: "female11", eyes: "female02", brows: "neutral02", nose: "small02", mouth: "grin01", eyewear: null, ears: "fox_ears01",
    colors: { skin: "fair", hair: "ginger", iris: "amber", cloth1: "forest", cloth2: "tan", cloth3: "yellow", metal: "gold" } } },
];

/** A preset as a whole cosmetic. */
export function applyPreset(p: Preset): Cosmetic {
  const { colors, ...rest } = p.cos;
  return { ...DEFAULT_COSMETIC, ...rest, colors: { ...DEFAULT_PALETTE, ...(colors ?? {}) } };
}

/* ------------------------------------------------------------------- plan */

export interface PlannedLayer extends Step {
  id: string;
}

/**
 * Turn a choice into the ordered list of masks to paint.
 *
 * Pure, and separate from the drawing, for the same reason `ORDER` is a
 * constant rather than a sequence of calls: the composite order is the part
 * that goes wrong, and this is what lets a test read it back without a canvas.
 *
 * It does NOT check that a file exists — `layers.ts` owns that, and a plan that
 * names a variant no option happens to have (six of the twenty-two eye layers
 * have no `_shadow`) is normal rather than an error. Those simply do not draw.
 */
export function personaPlan(cos: Cosmetic): PlannedLayer[] {
  const style = HAIRSTYLES.find((h) => h.id === cos.hair) ?? HAIRSTYLES[0]!;

  const pick = (step: Step): string | null => {
    if (step.part === "headwear") return cos.headwear;
    switch (step.slot) {
      case "hair/back":
        return style.back ?? null;
      case "hair/base":
        if (!style.base) return null;   // bald: nothing to draw, not an empty file
        return step.variant === "decoration" && !cos.hairDecoration ? null : style.base;
      case "hair/front":
        return style.front ?? null;
      case "body":
        return cos.body;
      case "ears":
        return cos.ears;
      case "horns":
        return cos.horns;
      case "cloths":
        return cos.outfit;
      case "neck":
        return cos.neckwear;
      case "mouth":
        return cos.mouth;
      case "nose":
        return cos.nose;
      case "eyes":
        return cos.eyes;
      case "brows":
        return cos.brows;
      case "beard":
        return cos.beard;
      case "glasses":
        return cos.eyewear;
    }
  };

  const out: PlannedLayer[] = [];
  for (const step of ORDER) {
    const id = pick(step);
    if (!id) continue;
    // Headwear is painted with what it is made of, not with the step's metal.
    const material = step.part === "headwear"
      ? HEADWEAR.find((h) => h.id === id)?.material ?? step.material
      : step.material;
    out.push({ ...step, material, id });
  }
  return out;
}
