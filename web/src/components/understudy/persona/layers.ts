/*
 * Where the 295 vendored PNGs are, according to the bundler.
 *
 * The art is checked in under `layers/`, not fetched, so the one thing that has
 * to happen at build time is turning those paths into hashed asset URLs. Vite's
 * `import.meta.glob` does it and nothing else has to know the filenames.
 *
 * WHY THE GLOB IS INSIDE A FUNCTION. `import.meta.glob` is a Vite compile-time
 * macro; it does not exist as a function anywhere else. And
 * web/test/hooks-module-scope.test.ts imports EVERY module under web/src in
 * bun, to catch the class of bug where a file dies while it is being loaded —
 * so if the glob ran at module scope, that suite would fail on this file with
 * "import.meta.glob is not a function" and take the black-window guard down
 * with it. Calling it lazily costs nothing (with `eager: true` Vite hoists the
 * imports out of the function anyway) and keeps this module importable
 * everywhere.
 *
 * The consequence, stated plainly: nothing in `bun test` can read the
 * catalogue. That is why the parse rule, the composite order and the curated
 * ids all live in `parts.ts` instead, and why the test rebuilds the catalogue
 * from `node:fs` rather than importing it from here.
 */
import { SLOTS, VARIANT_SUFFIX, splitLayerFile, type Slot, type Variant } from "./parts.ts";

/** `{ "./layers/body/male01.png": "/assets/male01-a1b2c3.png", ... }` */
function discover(): Record<string, string> {
  return import.meta.glob("./layers/**/*.png", {
    eager: true,
    query: "?url",
    import: "default",
  }) as Record<string, string>;
}

let urls: Record<string, string> | null = null;
function assets(): Record<string, string> {
  return (urls ??= discover());
}

export type Catalogue = Readonly<Record<Slot, readonly string[]>>;

let cached: Catalogue | null = null;

/**
 * Every option the art actually contains, per slot, sorted.
 *
 * Options, not files: `glasses01`, `glasses01_shadow`, `glasses01_reflection`
 * and `glasses01_reflection_shadow` collapse to the single id `glasses01`,
 * because they are one pair of glasses drawn in four passes. `parts.ts` owns
 * that rule — see `splitLayerFile`.
 *
 * This is the ground truth the curated lists in `parts.ts` are checked against.
 * A typo'd id there is a slot that silently renders nothing, which on a face is
 * a missing mouth rather than an error.
 */
export function catalogue(): Catalogue {
  if (cached) return cached;
  const found = {} as Record<Slot, Set<string>>;
  for (const slot of SLOTS) found[slot] = new Set<string>();

  for (const path of Object.keys(assets())) {
    const rel = path.replace(/^\.\/layers\//, "").replace(/\.png$/, "");
    const cut = rel.lastIndexOf("/");
    const dir = rel.slice(0, cut) as Slot;
    if (!(dir in found)) continue;
    found[dir].add(splitLayerFile(rel.slice(cut + 1)).id);
  }

  const out = {} as Record<Slot, readonly string[]>;
  for (const slot of SLOTS) out[slot] = [...found[slot]].sort();
  cached = out;
  return out;
}

/**
 * The asset URL for one mask, or `undefined` when the art has no such file.
 *
 * `undefined` is the normal answer and not a failure: six of the twenty-two eye
 * layers were drawn without a `_shadow`, and seven of the thirty-one fringes.
 * The composite skips whatever is missing.
 */
export function layerUrl(slot: Slot, id: string, variant: Variant = "base"): string | undefined {
  return assets()[`./layers/${slot}/${id}${VARIANT_SUFFIX[variant]}.png`];
}
