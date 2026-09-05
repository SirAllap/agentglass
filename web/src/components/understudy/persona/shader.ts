/*
 * The portrait shader, taken off the GPU.
 *
 * Every PNG under `layers/` is a MASK, not a picture. Open one in an image
 * viewer and you get a flat red-green-blue silhouette; the colour comes from
 * here. The art is V-ktor/pixel-art-portraits (CC-BY 4.0, see ART-LICENSE.txt),
 * drawn for Godot, and this is the fragment shader it shipped with, verbatim
 * and unedited — it is the source of truth for everything below:
 *
 *     vec4 mask = texture(TEXTURE,UV);
 *     float weight = min(10.0*max(abs(mask.r-mask.g),abs(mask.b-mask.g)),1.0);
 *     float value = (mask.r+mask.g+mask.b)/3.0;
 *     COLOR = (dark_color*mask.r + light_color*mask.g + shadow_color*mask.b)*weight
 *           + (black_color*(1.0-value) + white_color*value)*(1.0-weight);
 *     COLOR.a = mask.a;
 *
 * Read it as two paths that cross-fade by `weight`:
 *
 *   - The TINTED path. R weights the dark tone, G the light tone, B the shadow
 *     tone. The masks use pure channels for the flat areas and #808000 — half
 *     red, half green, no blue — for the tone between dark and light, which is
 *     why a body layer is 3273 green pixels, 610 olive and 295 red rather than
 *     one flat colour.
 *   - The NEUTRAL path. Where the three channels are nearly equal the pixel is
 *     grey, `weight` collapses to 0, and the colour lerps black -> white by the
 *     pixel's own value. That is how eye whites (#ffffff), pupils (#000000) and
 *     the metal glint on a pair of glasses work: they are the same tone for
 *     everybody and must not follow the iris or the frame.
 *
 * `weight` multiplies by 10 rather than being a step, so a channel that is
 * within a tenth of neutral fades between the two paths instead of snapping.
 *
 * Deliberately a pure function over a Uint8ClampedArray and not a canvas
 * operation: this is the only part of the persona with real arithmetic in it,
 * and `bun test` has no `<canvas>` to render into. Everything here can be
 * checked against four hand-built pixels — see web/test/understudy-persona.test.ts.
 */

/**
 * The subset of `ImageData` this file needs, and the reason it is not
 * `ImageData` itself.
 *
 * A browser's `ImageData` also carries a `colorSpace`, and its constructor does
 * not exist in bun — so a test could neither build an input nor satisfy the
 * type. A real `ImageData` is structurally assignable to this, so callers hand
 * `ctx.getImageData(...)` straight in and nothing casts.
 */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** The five colours the shader takes. `black`/`white` drive the neutral path. */
export interface Tones {
  light: string;
  dark: string;
  shadow: string;
  black?: string;
  white?: string;
}

/* ------------------------------------------------------------------ colour */

export function hexToRgb(hex: string): [number, number, number] {
  const s = hex.replace("#", "");
  return [
    parseInt(s.slice(0, 2), 16) || 0,
    parseInt(s.slice(2, 4), 16) || 0,
    parseInt(s.slice(4, 6), 16) || 0,
  ];
}

export function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const k = Math.floor(h / 60);
  const [r, g, b] =
    k === 0 ? [c, x, 0]
    : k === 1 ? [x, c, 0]
    : k === 2 ? [0, c, x]
    : k === 3 ? [0, x, c]
    : k === 4 ? [x, 0, c]
    : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Shadow, shade, mid, light, highlight. Index 2 is the colour you passed in. */
export type Ramp = readonly [string, string, string, string, string];

/*
 * The ramp: one colour in, five out.
 *
 * A caller should never have to pick five shades that agree with each other,
 * and the persona editor has six materials — asking for thirty hexes would be
 * asking for a muddy portrait. So the UI offers ONE mid tone per material and
 * the other four are derived, the way a pixel artist derives them: not by
 * dimming, which greys out, but by rotating the hue as the value falls.
 * Shadows go cool and purple, highlights go warm and yellow, and saturation
 * peaks in the middle and drops off both ends.
 *
 * The numbers are fitted to Endesga 32's skin ramp, which is the reference the
 * test pins: fed #b86f50 this returns #3e2731 #733e39 #b86f50 #e4a672 #ead4aa
 * to within one unit per channel.
 *
 * Two of them are not round, and that is deliberate. The highlight rung was
 * first written as 0.47 saturation / 1.28 value, which overshoots E32's
 * #ead4aa by (+2,+2,+3) — visible as a chalky top end on a 96px face. The
 * ratios measured off the palette itself are 0.4839 and 1.2718; rounded to
 * three places they land the rung exactly. Rounding them back to two would
 * put the error back.
 */
const HUE_DELTA = [-44, -13, 0, 9, 21] as const;
const SATURATION = [0.65, 0.88, 1.0, 0.88, 0.484] as const;
const VALUE = [0.33, 0.63, 1.0, 1.24, 1.272] as const;

/**
 * Derive the five-tone ramp for a material from its mid tone.
 *
 * `cool` mirrors the hue rotation. The default suits anything lit warm —
 * skin, hair, wood — where the shadow falls toward purple and the highlight
 * toward yellow. Mirror it for a material read as cool (steel, denim, a
 * screen's glow): a blue at h=220 wants its shadow deeper into violet at 264
 * and its highlight up into cyan at 199, and rotating it the warm way instead
 * walks the shadow toward teal, which reads as a different object rather than
 * the same one in the dark.
 */
export function ramp(midHex: string, cool = false): Ramp {
  const [h, s, v] = rgbToHsv(...hexToRgb(midHex));
  const five = HUE_DELTA.map((dh, i) =>
    rgbToHex(hsvToRgb(h + (cool ? -dh : dh), Math.min(1, s * SATURATION[i]!), Math.min(1, v * VALUE[i]!))),
  );
  return five as unknown as Ramp;
}

/**
 * The ramp as the shader wants it.
 *
 * Note which rung goes where: the LIGHT tone is the top of the ramp and the
 * DARK tone is the mid you passed in. That is not a mix-up — the masks fill
 * the broad areas with green, so the light tone is the colour of the face and
 * the dark tone is what shades it. Handing the mid to `light` instead paints a
 * face in its own shadow colour.
 */
export function material(midHex: string, cool = false): Tones {
  const r = ramp(midHex, cool);
  return { light: r[4], dark: r[2], shadow: r[0] };
}

/**
 * The tones for a `_shadow.png` mask.
 *
 * Those files are not part of their own layer: they are the shadow that layer
 * CASTS on whatever is underneath it, so hair/base/male01_shadow.png is a
 * shape to darken the FACE with, and it gets the skin's ramp rather than the
 * hair's. Every one of the 63 of them is a flat #808000, which the tinted path
 * resolves to the midpoint of `dark` and `light` — so both are set to the same
 * rung and the mask comes out one flat shade.
 *
 * Rung 1 rather than rung 0: rung 0 is the deepest shadow the art itself
 * paints with blue, and a cast shadow that lands on it has nowhere darker to
 * go, which flattens the jaw into a silhouette.
 */
export function castShadow(midHex: string, cool = false): Tones {
  const r = ramp(midHex, cool);
  return { light: r[1], dark: r[1], shadow: r[0] };
}

/* ------------------------------------------------------------------ shader */

/**
 * The shader at the top of this file, over a whole image.
 *
 * Nothing is premultiplied and alpha is copied through byte for byte: these
 * masks have hard edges (every pixel is either fully opaque or fully clear),
 * and a rounding trip through premultiplied alpha is how a pixel-art edge
 * picks up a fringe.
 */
export function tint(src: Pixels, c: Tones): Pixels {
  const dark = hexToRgb(c.dark);
  const light = hexToRgb(c.light);
  const shadow = hexToRgb(c.shadow);
  const black = hexToRgb(c.black ?? "#000000");
  const white = hexToRgb(c.white ?? "#ffffff");

  const src4 = src.data;
  const out = new Uint8ClampedArray(src4.length);

  for (let i = 0; i < src4.length; i += 4) {
    const a = src4[i + 3]!;
    if (a === 0) continue; // out is already zeroed; a clear pixel stays clear
    const r = src4[i]! / 255;
    const g = src4[i + 1]! / 255;
    const b = src4[i + 2]! / 255;

    const weight = Math.min(10 * Math.max(Math.abs(r - g), Math.abs(b - g)), 1);
    const value = (r + g + b) / 3;
    const neutral = 1 - weight;

    for (let k = 0; k < 3; k++) {
      out[i + k] =
        (dark[k]! * r + light[k]! * g + shadow[k]! * b) * weight +
        (black[k]! * (1 - value) + white[k]! * value) * neutral;
    }
    out[i + 3] = a;
  }

  return { data: out, width: src.width, height: src.height };
}

/**
 * Source-over, in JavaScript, into `dst`.
 *
 * The alternative is a scratch <canvas> per layer and fourteen `drawImage`
 * calls, because `putImageData` REPLACES rather than blends and would erase
 * the face every time a layer above it was stamped down. Doing it here instead
 * means one `putImageData` at the end of the whole composite, and it keeps the
 * order of operations somewhere a test can read it.
 */
export function over(dst: Pixels, src: Pixels): void {
  const d = dst.data;
  const s = src.data;
  for (let i = 0; i < s.length; i += 4) {
    const sa = s[i + 3]! / 255;
    if (sa === 0) continue;
    const da = d[i + 3]! / 255;
    const oa = sa + da * (1 - sa);
    for (let k = 0; k < 3; k++) {
      d[i + k] = (s[i + k]! * sa + d[i + k]! * da * (1 - sa)) / oa;
    }
    d[i + 3] = oa * 255;
  }
}
