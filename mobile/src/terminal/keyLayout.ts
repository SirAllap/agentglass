/*
 * Which accessory keys the bar shows, and in what order.
 *
 * ── why this is worth a setting at all ───────────────────────────────────
 * There are seventeen of them and a phone shows six or seven at the fold. The
 * rest are behind a horizontal drag on a strip whose contents you cannot see —
 * which is the same objection this project already made about the repository
 * chips, and it applies here for a worse reason: the keys people actually use
 * are not the same set for any two people. Somebody living in `less` wants
 * ^U and ^R at the front; somebody driving an agent wants Esc and ^C and
 * nothing else. A fixed order is a guess made once for everybody.
 *
 * ── the shape of what is stored ──────────────────────────────────────────
 * An order and a hidden set, NOT a list of the keys to show. The difference is
 * what happens when a key is added to ACCESSORY_KEYS in a later version: with
 * a stored allow-list it would be invisible to everybody who had ever opened
 * this screen, silently, and the only clue would be a key that exists on a
 * fresh install and not on yours. With a hidden set the new key appears, which
 * is what somebody would expect of a new key.
 *
 * Ids that no longer exist are dropped on the way in rather than kept: a
 * renamed key would otherwise hold a slot in the order for ever.
 *
 * ── pure, and separate from the storage ──────────────────────────────────
 * Nothing here reads a keystore. `apply` takes a layout and a catalogue and
 * answers with a list, which is what makes every rule below testable — and the
 * rules are the part worth testing, since the failure mode of getting one
 * wrong is a key bar that silently lost Ctrl+C.
 */
import type { AccessoryKey } from "./keys.ts";

export interface KeyLayout {
  /** Ids, in the order they should be drawn. Anything in the catalogue and not
   *  in here goes after, in the catalogue's own order — that is how a key added
   *  in a later version arrives without a migration. */
  order: string[];
  /** Ids the bar does not draw. */
  hidden: string[];
}

/** Nothing chosen: the catalogue's own order, nothing hidden.
 *
 *  Frozen, and its arrays with it. A spread of this object copies the object
 *  and SHARES the two arrays, so a caller that pushed to `hidden` would be
 *  editing the default for the rest of the process — which is a preference
 *  that appears to reset itself and never quite does. Freezing turns that from
 *  a silent corruption into a throw in development, and `fresh()` below is the
 *  copy every caller actually wants. */
export const DEFAULT_LAYOUT: KeyLayout = Object.freeze({
  order: Object.freeze([]) as unknown as string[],
  hidden: Object.freeze([]) as unknown as string[],
});

/** A layout nobody else holds a reference into. */
const fresh = (): KeyLayout => ({ order: [], hidden: [] });

/**
 * The keys to draw, in the order to draw them.
 *
 * The one rule that is not obvious: the bar is never allowed to be empty. A
 * layout that hides everything is a screen with no Escape and no Ctrl+C on it,
 * reachable in two taps and with nothing on the terminal to undo it — the
 * settings screen is somewhere else, and getting to it means leaving the pane.
 * So the last visible key cannot be hidden; `canHide` is what the screen asks
 * before it offers the switch.
 */
export function apply(layout: KeyLayout, catalogue: readonly AccessoryKey[]): AccessoryKey[] {
  const known = new Map(catalogue.map((k) => [k.id, k]));
  const hidden = new Set(layout.hidden.filter((id) => known.has(id)));

  const out: AccessoryKey[] = [];
  const placed = new Set<string>();
  for (const id of layout.order) {
    const key = known.get(id);
    // Unknown ids and duplicates both simply do not place. A stored order is
    // data from an older version of this app and cannot be trusted to be a
    // permutation of anything.
    if (!key || placed.has(id) || hidden.has(id)) continue;
    out.push(key);
    placed.add(id);
  }
  for (const key of catalogue) {
    if (placed.has(key.id) || hidden.has(key.id)) continue;
    out.push(key);
    placed.add(key.id);
  }
  return out;
}

/** Every key with whether it is currently shown, in the order the settings
 *  screen lists them — which is the order the BAR uses, so the list a person
 *  reorders is the thing they are looking at. Hidden ones go last. */
export function rows(
  layout: KeyLayout,
  catalogue: readonly AccessoryKey[],
): { key: AccessoryKey; shown: boolean }[] {
  const visible = apply(layout, catalogue);
  const seen = new Set(visible.map((k) => k.id));
  return [
    ...visible.map((key) => ({ key, shown: true })),
    ...catalogue.filter((k) => !seen.has(k.id)).map((key) => ({ key, shown: false })),
  ];
}

/** False when hiding this one would empty the bar. See `apply`. */
export function canHide(layout: KeyLayout, catalogue: readonly AccessoryKey[], id: string): boolean {
  const visible = apply(layout, catalogue);
  return !(visible.length <= 1 && visible[0]?.id === id);
}

/** Show or hide one key. Hiding the last visible one is refused rather than
 *  silently ignored — the caller does not offer the control, and this is the
 *  second line of that defence. */
export function toggle(layout: KeyLayout, catalogue: readonly AccessoryKey[], id: string): KeyLayout {
  const hidden = new Set(layout.hidden);
  if (hidden.has(id)) {
    hidden.delete(id);
  } else {
    if (!canHide(layout, catalogue, id)) return layout;
    hidden.add(id);
  }
  return { order: layout.order, hidden: [...hidden] };
}

/**
 * Move a visible key one place earlier or later.
 *
 * The order is rewritten in full from what is currently VISIBLE rather than
 * patched, which is what keeps a stored order that was never complete — every
 * layout starts as `[]` — from having to be complete before it can be edited.
 * Hidden ids are carried along at the end so unhiding one does not send it to
 * the back of a bar it used to be near the front of.
 */
export function move(
  layout: KeyLayout,
  catalogue: readonly AccessoryKey[],
  id: string,
  by: -1 | 1,
): KeyLayout {
  const visible = apply(layout, catalogue).map((k) => k.id);
  const at = visible.indexOf(id);
  if (at < 0) return layout;
  const to = at + by;
  if (to < 0 || to >= visible.length) return layout;
  const next = [...visible];
  next[at] = visible[to]!;
  next[to] = id;
  // Everything hidden keeps whatever place it had, after the visible run.
  const tail = layout.order.filter((o) => !next.includes(o));
  return { order: [...next, ...tail], hidden: layout.hidden };
}

/** Back to the catalogue's own order with nothing hidden. */
export const reset = (): KeyLayout => fresh();

/**
 * A stored string, read defensively.
 *
 * Anything that is not the shape this file writes answers with the default. A
 * keystore value is the one input here that can be from a different version of
 * the app, and a throw on a cold start would be a phone that cannot draw its
 * terminal because of a preference.
 */
export function parse(raw: string | null | undefined): KeyLayout {
  if (!raw) return fresh();
  try {
    const got = JSON.parse(raw) as Partial<KeyLayout>;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return { order: strings(got.order), hidden: strings(got.hidden) };
  } catch {
    return fresh();
  }
}

export const serialise = (layout: KeyLayout): string => JSON.stringify(layout);
