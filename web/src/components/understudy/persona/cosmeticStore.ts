/*
 * The one place the understudy's look is kept.
 *
 * It is edited in Settings and worn in the understudy view, and those are two
 * trees that share no parent below App. A prop would have to climb out of one
 * and down into the other; a `useState` in either would leave the other
 * showing yesterday's face until a reload. So: one module-level value, a
 * subscriber list, and `useSyncExternalStore`, which is what React offers for
 * exactly this shape of thing.
 *
 * Persistence is localStorage, under the key the first version used, and a
 * stored choice is VALIDATED on the way in rather than trusted: an id the art
 * no longer has — a build that renamed a style, a hand-edited value — falls
 * back to the default for that slot instead of rendering a portrait with a
 * hole in it. The same goes for a colour: a swatch id that is not on the list
 * paints the default, never nothing.
 */
import { useSyncExternalStore } from "react";
import {
  BEARDS, BODIES, BROWS, DEFAULT_COSMETIC, DEFAULT_PALETTE, EARS, EYES, EYEWEAR, HAIRSTYLES,
  HEADWEAR, HORNS, MOUTHS, NECKWEAR, NOSES, OUTFITS, type Cosmetic, type Option, type Palette,
} from "./parts.ts";
import { SWATCHES, type SwatchKind } from "./swatches.ts";

/* The stored key keeps the OLD word on purpose. It is a localStorage key, not
   a label: renaming it does not rename anything he can see, it just orphans
   the portrait he has already built and hands him a bald default. */
export const COSMETIC_KEY = "agentglass.understudy.cosmetic";

const IN = (list: readonly Option[], v: unknown, fallback: string): string =>
  typeof v === "string" && list.some((o) => o.id === v) ? v : fallback;

const IN_OPT = (list: readonly Option[], v: unknown): string | null =>
  typeof v === "string" && list.some((o) => o.id === v) ? v : null;

const SW = (kind: SwatchKind, v: unknown, fallback: string): string =>
  typeof v === "string" && SWATCHES[kind].some((s) => s.id === v) ? v : fallback;

/** A stored value, or anything shaped like one, made into a cosmetic every id of which exists. */
export function validateCosmetic(raw: unknown): Cosmetic {
  // Not an object at all is not a choice with holes in it; it is no choice.
  if (!raw || typeof raw !== "object") return DEFAULT_COSMETIC;
  const s = raw as Record<string, unknown>;
  const c = (s.colors && typeof s.colors === "object" ? s.colors : {}) as Record<string, unknown>;
  const colors: Palette = {
    skin: SW("skin", c.skin, DEFAULT_PALETTE.skin),
    hair: SW("hair", c.hair, DEFAULT_PALETTE.hair),
    iris: SW("iris", c.iris, DEFAULT_PALETTE.iris),
    lips: SW("lips", c.lips, DEFAULT_PALETTE.lips),
    cloth1: SW("cloth", c.cloth1, DEFAULT_PALETTE.cloth1),
    cloth2: SW("cloth", c.cloth2, DEFAULT_PALETTE.cloth2),
    cloth3: SW("cloth", c.cloth3, DEFAULT_PALETTE.cloth3),
    metal: SW("metal", c.metal, DEFAULT_PALETTE.metal),
  };
  return {
    body: IN(BODIES, s.body, DEFAULT_COSMETIC.body),
    hair: IN(HAIRSTYLES, s.hair, DEFAULT_COSMETIC.hair),
    outfit: IN(OUTFITS, s.outfit, DEFAULT_COSMETIC.outfit),
    eyes: IN(EYES, s.eyes, DEFAULT_COSMETIC.eyes),
    brows: IN(BROWS, s.brows, DEFAULT_COSMETIC.brows),
    nose: IN(NOSES, s.nose, DEFAULT_COSMETIC.nose),
    mouth: IN(MOUTHS, s.mouth, DEFAULT_COSMETIC.mouth),
    beard: IN_OPT(BEARDS, s.beard),
    eyewear: IN_OPT(EYEWEAR, s.eyewear),
    neckwear: IN_OPT(NECKWEAR, s.neckwear),
    ears: IN_OPT(EARS, s.ears),
    horns: IN_OPT(HORNS, s.horns),
    headwear: IN_OPT(HEADWEAR, s.headwear),
    hairDecoration: s.hairDecoration === true,
    colors,
  };
}

export function loadCosmetic(): Cosmetic {
  try {
    const raw = localStorage.getItem(COSMETIC_KEY);
    if (!raw) return DEFAULT_COSMETIC;
    return validateCosmetic(JSON.parse(raw));
  } catch {
    return DEFAULT_COSMETIC;
  }
}

export function saveCosmetic(c: Cosmetic): void {
  try {
    localStorage.setItem(COSMETIC_KEY, JSON.stringify(c));
  } catch { /* private mode, and a portrait is not worth a thrown render */ }
}

/* ------------------------------------------------------------------ store */

let current: Cosmetic | null = null;
const subs = new Set<() => void>();

function read(): Cosmetic {
  return (current ??= loadCosmetic());
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/** Set the look everywhere it is shown, and keep it. */
export function setCosmetic(next: Cosmetic): void {
  current = next;
  saveCosmetic(next);
  for (const fn of subs) fn();
}

/** The look, live: every subscriber repaints when any of them changes it. */
export function useCosmetic(): Cosmetic {
  return useSyncExternalStore(subscribe, read, read);
}
