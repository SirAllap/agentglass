import { enabledOf } from "./polarisView.ts";
import type { ItemsAnswer, SettingsAnswer } from "../../../shared/polaris.ts";

/** What the empty Polaris pull request list says, and why. `null` = say nothing (loading, or the list has rows). */
export type PrsEmpty = { kind: "off" | "none" | "error"; text: string } | null;

export function prsEmptyNote(settings: SettingsAnswer | null, items: ItemsAnswer | null, error: string | null): PrsEmpty {
  if (error) return { kind: "error", text: error };
  if (!settings) return null;
  if (!enabledOf(settings)) return { kind: "off", text: "Polaris is off, so it watches nothing. Turn it on in Polaris." };
  if (!items || items.uncharted || items.items.length > 0) return null;
  return { kind: "none", text: "No open pull requests in this project." };
}
