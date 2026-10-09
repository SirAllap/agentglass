import type { Tone } from "../../../shared/pluginUi.ts";
import type { Tone as RowTone } from "../components/git/ui.tsx";

/** A plugin's tone word, as the app's own chip spells it. One table for every
 *  place a plugin's word becomes a chip (its panels, the Inbox), so a tone
 *  cannot mean one colour in one and another in the next. */
export const TO_ROW_TONE: Record<Tone, RowTone> = {
  default: "neutral", muted: "neutral", accent: "accent", success: "good", warning: "warn", danger: "bad",
};

/** The colour a tone paints with: a dot, a stroke, a tint. */
export const TONE_COLOR: Record<Tone, string> = {
  default: "var(--text)",
  muted: "var(--text3)",
  accent: "var(--primary)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--error)",
};

/** The same tones for TEXT: the `--*-ink` set, which clears 4.5:1 on the
 *  theme's ground where the bare tint may not. */
export const TONE_INK: Record<Tone, string> = {
  default: "var(--text)",
  muted: "var(--text3)",
  accent: "var(--primary-ink)",
  success: "var(--success-ink)",
  warning: "var(--warning-ink)",
  danger: "var(--error-ink)",
};
