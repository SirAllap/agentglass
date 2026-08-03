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
export interface Accent { id: string; name: string; primary: string; hover: string }

export const ACCENTS: Accent[] = [
  { id: "", name: "Theme", primary: "", hover: "" },
  { id: "blue", name: "Blue", primary: "#3b82f6", hover: "#60a5fa" },
  { id: "violet", name: "Violet", primary: "#8b5cf6", hover: "#a78bfa" },
  { id: "green", name: "Green", primary: "#22c55e", hover: "#4ade80" },
  { id: "amber", name: "Amber", primary: "#f59e0b", hover: "#fbbf24" },
  { id: "rose", name: "Rose", primary: "#f43f5e", hover: "#fb7185" },
  { id: "cyan", name: "Cyan", primary: "#06b6d4", hover: "#22d3ee" },
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
