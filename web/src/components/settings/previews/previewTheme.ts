import type { CSSProperties } from "react";
import { THEMES } from "../../../lib/themes.ts";
import { ACCENTS } from "../../../lib/accent.ts";
import { floorTiers, inkTints, onPrimaryInk } from "../../../lib/contrast.ts";

/**
 * The tokens of a theme and an accent, as inline custom properties on the
 * preview's own root: the miniature wears the theme the person is picking
 * without the app changing under their hands. The app paints the same way
 * (floor under the dim tiers, ink tints, accent over the primary), only onto
 * the document. An id that is not a listed theme (the desktop's live palette,
 * "system") yields nothing, so the preview inherits what the app wears.
 */
export function previewVars(themeId?: string | null, accentId?: string | null): CSSProperties {
  const t = themeId ? THEMES.find((x) => x.id === themeId) : undefined;
  const vars: Record<string, string> = t ? { ...inkTints(floorTiers(t.vars as Record<string, string>), t.ansi) } : {};
  const a = accentId ? ACCENTS.find((x) => x.id === accentId) : undefined;
  if (a && a.primary) { vars["--primary"] = a.primary; vars["--primary-hover"] = a.hover; }
  const bg = vars["--bg"], text = vars["--text"], primary = vars["--primary"];
  const on = primary && bg && text ? onPrimaryInk(primary, bg, text) : undefined;
  if (on) vars["--on-primary"] = on;
  return vars as CSSProperties;
}
