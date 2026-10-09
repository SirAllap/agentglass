/*
 * An accent colour, laid over whatever theme is active.
 *
 * The serious defaults are monochrome by design — a grey primary so nothing
 * competes with the work — but some people want one colour back for the things
 * that read as "live": active tab, selection, cursor, links-as-buttons. This
 * overrides `--primary` / `--primary-hover` on the root, on top of the theme,
 * so the choice travels across a theme switch. Semantic colours (success,
 * error, the terminal's own blue) are left alone. "Theme" means no override —
 * the theme's own primary shows through.
 */
import { ACCENTS as SHARED_ACCENTS } from "../../../shared/palettes.ts";
import { onPrimaryInk } from "./contrast.ts";

export interface Accent { id: string; name: string; primary: string; hover: string }

/*
 * The six hues now live in shared/palettes.ts, because the phone offers the
 * same six and a colour with two homes is a colour with two values eventually.
 * "Theme" stays here: it is this app's own idea — do not override, let whichever
 * of thirty-seven palettes is on show its own primary — and it means nothing on
 * a phone that has two.
 */
export const ACCENTS: Accent[] = [
  { id: "", name: "Theme", primary: "", hover: "" },
  ...SHARED_ACCENTS,
];

const KEY = "agentglass-accent";
/* The colour to come back to when the follow switch is turned off. Without it,
   turning the switch off would land on nothing and the row would read as
   broken; with it, the switch is reversible and lands where the person was. */
const LAST = "agentglass-accent-last";

export function currentAccent(): string {
  try { return localStorage.getItem(KEY) || ""; } catch { return ""; }
}

/**
 * Lay the chosen accent over the theme's primary. Called at the end of every
 * `applyTheme`, so a theme switch re-asserts it rather than dropping it. For the
 * "Theme" default it does nothing — the theme's own `--primary`, just set by
 * applyTheme, is left in place. (Clearing an accent therefore has to re-apply
 * the theme first; `setAccent` does not, which is why the picker re-applies.)
 */
export function applyAccent(): void {
  const a = ACCENTS.find((x) => x.id === currentAccent());
  const root = document.documentElement.style;
  /* The theme's own primary, kept before the overlay goes on. This function is
     called at the end of every `applyTheme`, so at this line `--primary` is
     still the theme's — one line later it may be an accent. The swatch that
     says which colour the app is following has to read this one: reading
     `--primary` would paint the override on top of itself, and the swatch
     would agree with whatever it was meant to contradict. */
  const own = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  if (own) root.setProperty("--theme-primary", own);
  if (a && a.primary) {
    root.setProperty("--primary", a.primary);
    root.setProperty("--primary-hover", a.hover);
    // The ink on the fill follows the colour that is now the fill, not the one
    // the theme painted it for.
    const cs = getComputedStyle(document.documentElement);
    const on = onPrimaryInk(a.primary, cs.getPropertyValue("--bg").trim(), cs.getPropertyValue("--text").trim());
    if (on) root.setProperty("--on-primary", on);
  }
}

/** Persist the accent choice. The caller re-applies the current theme so the
 *  overlay (or its removal, for "Theme") takes effect immediately. */
export function setAccentPref(id: string): void {
  try {
    if (id) { localStorage.setItem(KEY, id); localStorage.setItem(LAST, id); }
    else localStorage.removeItem(KEY);
  } catch {}
}

/** The accent to restore when the follow switch goes off, for someone who has
 *  never picked one. Teal because it is the phone's default, so a person who
 *  has both ends up in the same place on either. */
export function lastAccent(): string {
  try { return localStorage.getItem(LAST) || "teal"; } catch { return "teal"; }
}
