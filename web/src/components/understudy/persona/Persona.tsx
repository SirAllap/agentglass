/*
 * The understudy's face.
 *
 * Fourteen 96x96 masks, each run through the shader in `shader.ts`, composited
 * in the order `parts.ts` fixes, painted once into a <canvas> and scaled up by
 * CSS with `image-rendering: pixelated`.
 *
 * WHY A CANVAS AND NOT FOURTEEN <img>. The PNGs are masks, not pictures — a
 * layer stacked with CSS renders as a flat red-green-blue silhouette. The
 * colour only exists after the per-pixel pass, and that pass needs the bytes.
 *
 * WHY THE COLOURS DO NOT FOLLOW THE THEME. Everything else in this app draws
 * from `var(--...)` and this file is the deliberate exception: the persona's
 * skin, hair and jacket come from `cos.colors`, which names swatches in
 * `swatches.ts` — art, drawn against Endesga 32. A portrait is a picture of a
 * person, and people do not change colour when the wall behind them is
 * repainted. Switching to Porcelain must change the surface UNDER the persona
 * and nothing in it. If you have arrived here to "fix" the hard-coded hexes:
 * they are in `swatches.ts`, they are art, and they stay.
 */
import { useEffect, useRef, type CSSProperties } from "react";
import { layerUrl } from "./layers.ts";
import { personaPlan, type Cosmetic, type Palette, type PlannedLayer } from "./parts.ts";
import { over, tint, type Pixels, type Tones } from "./shader.ts";
import { PUPIL, SCLERA, castTones, lipTones, swatch } from "./swatches.ts";

/** The art's native size. Every layer is exactly this square. */
export const PERSONA_PX = 96;

/*
 * Decoded masks, cached forever, keyed by asset URL.
 *
 * Module level rather than per component, and the reason is the editor: the
 * picker redraws the whole portrait on every keystroke of a colour field and on
 * every arrow through a list of hairstyles. Without this, changing the mouth
 * re-decodes the body, the jacket, both hair layers and the glasses — thirteen
 * PNGs whose bytes have not changed — and the picker stutters. The art is 295
 * files totalling under 200 KB, so holding every mask a session ever touches
 * costs less than one screenshot.
 *
 * `null` is a cached MISS. A mask that failed to decode must not be retried on
 * every repaint.
 */
const decoded = new Map<string, Pixels | null>();
/** In-flight decodes, so eight components mounting at once share one request. */
const pending = new Map<string, Promise<Pixels | null>>();

async function readMask(url: string): Promise<Pixels | null> {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const scratch = document.createElement("canvas");
  scratch.width = PERSONA_PX;
  scratch.height = PERSONA_PX;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, PERSONA_PX, PERSONA_PX);
}

function mask(url: string): Promise<Pixels | null> {
  const hit = decoded.get(url);
  if (hit !== undefined) return Promise.resolve(hit);
  const already = pending.get(url);
  if (already) return already;
  const run = readMask(url).then((px) => {
    decoded.set(url, px);
    pending.delete(url);
    return px;
  });
  pending.set(url, run);
  return run;
}

/**
 * The five colours one layer is painted with.
 *
 * Every material resolves to a swatch by id (`swatches.ts`), except the two
 * that depend on another: a cast shadow is the SKIN's shade, because it is the
 * shadow a layer throws onto the face; and natural lips are the skin's shade
 * too, because a fixed pink on a deep skin is lipstick.
 *
 * Two slots need the shader's NEUTRAL path steered, and both are places where
 * the art draws a tone that belongs to everybody rather than to the material:
 *
 *   - `brows` is 100% pure black in all nine files, which the shader resolves
 *     entirely through `black_color`. Left at the default the eyebrows come out
 *     jet black on every head, including the blonde one. They get the hair's
 *     shade — hair in its own shadow, which is what a brow is.
 *   - `eyes` carries the sclera as #ffffff and the pupil as #000000, and those
 *     must not follow the iris colour or a green-eyed portrait gets green
 *     whites.
 */
export function tonesFor(layer: PlannedLayer, colors: Palette): Tones {
  const skin = swatch("skin", colors.skin).tones;
  const hair = swatch("hair", colors.hair).tones;
  let base: Tones;
  switch (layer.material) {
    case "cast": base = castTones(skin); break;
    case "skin": base = skin; break;
    case "hair": base = hair; break;
    case "lips": base = lipTones(colors.lips, skin); break;
    case "iris": base = swatch("iris", colors.iris).tones; break;
    case "cloth1": base = swatch("cloth", colors.cloth1).tones; break;
    case "cloth2": base = swatch("cloth", colors.cloth2).tones; break;
    case "cloth3": base = swatch("cloth", colors.cloth3).tones; break;
    case "metal": base = swatch("metal", colors.metal).tones; break;
  }
  if (layer.slot === "brows") return { ...base, black: hair.dark };
  if (layer.slot === "eyes") return { ...base, black: PUPIL, white: SCLERA };
  return base;
}

export function Persona({
  px = PERSONA_PX,
  cos,
  label = "The clone",
  className,
  style,
}: {
  /**
   * Rendered size in CSS pixels.
   *
   * Named `px` and NOT `size`: `size` is the icon ladder's prop, and
   * web/test/icon-scale.test.ts holds every `size=` default at or above 12px
   * because a stroked glyph under that stops resolving. A portrait is not a
   * glyph and has nothing to do with that floor, so it stays off that name
   * rather than borrowing a rule written for something else.
   *
   * Whole multiples of 96 are exact — 96, 192, 288. Anything else asks the
   * browser to resample a pixel grid, and `image-rendering: pixelated` will
   * round some source pixels to two screen pixels and some to one, which reads
   * as a wobble along the jaw.
   */
  px?: number;
  cos: Cosmetic;
  label?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);

  /* The effect has to re-run when any FIELD of `cos` changes, and a caller
     writing `cos={{ ...saved }}` inline hands us a new object every render. So
     the dependency is the value of the choice, and the choice itself is read
     off a ref — which is always the render that produced this key. */
  const key = JSON.stringify(cos);
  const held = useRef(cos);
  held.current = cos;

  useEffect(() => {
    let live = true;
    const colors = held.current.colors;
    const steps = personaPlan(held.current)
      .map((layer) => ({ url: layerUrl(layer.slot, layer.id, layer.variant), tones: tonesFor(layer, colors) }))
      // A missing file is normal, not an error: six of the twenty-two eye
      // layers were drawn without a `_shadow`, and seven of the fringes.
      .filter((s): s is { url: string; tones: Tones } => typeof s.url === "string");

    void (async () => {
      const masks = await Promise.all(steps.map((s) => mask(s.url)));
      if (!live) return;
      const ctx = canvas.current?.getContext("2d");
      if (!ctx) return;

      const out: Pixels = {
        data: new Uint8ClampedArray(PERSONA_PX * PERSONA_PX * 4),
        width: PERSONA_PX,
        height: PERSONA_PX,
      };
      masks.forEach((m, i) => {
        if (m) over(out, tint(m, steps[i]!.tones));
      });

      /* One `putImageData` for the whole portrait. It REPLACES rather than
         blends, which is exactly right here — `over()` already did the
         blending, and replacing is also what clears the previous face. */
      const frame = ctx.createImageData(PERSONA_PX, PERSONA_PX);
      frame.data.set(out.data);
      ctx.putImageData(frame, 0, 0);
    })();

    return () => {
      live = false;
    };
  }, [key]);

  return (
    <canvas
      ref={canvas}
      width={PERSONA_PX}
      height={PERSONA_PX}
      role="img"
      aria-label={label}
      className={className}
      style={{ width: px, height: px, imageRendering: "pixelated", ...style }}
    />
  );
}
