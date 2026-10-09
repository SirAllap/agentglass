import type { Tone } from "../../../shared/pluginUi.ts";
import type { Tone as RowTone } from "../components/git/ui.tsx";

/** A plugin's tone word, as the app's own chip spells it. One table for every
 *  place a plugin's word becomes a chip (its panels, the Inbox), so a tone
 *  cannot mean one colour in one and another in the next. */
export const TO_ROW_TONE: Record<Tone, RowTone> = {
  default: "neutral", muted: "neutral", accent: "accent", success: "good", warning: "warn", danger: "bad",
};
