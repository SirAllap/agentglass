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
  if (a && a.primary) {
    root.setProperty("--primary", a.primary);
    root.setProperty("--primary-hover", a.hover);
  }
}

/** Persist the accent choice. The caller re-applies the current theme so the
 *  overlay (or its removal, for "Theme") takes effect immediately. */
export function setAccentPref(id: string): void {
  try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch {}
}
