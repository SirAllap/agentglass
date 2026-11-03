/**
 * What the OpenCode Go card says about the key and the last reading.
 *
 * Pulled out of the component so the three states a key can be in — none, set,
 * refused for a missing permission — are testable without a renderer, and so
 * the card cannot show "Reading" while it is only counting this PC's turns.
 */
import type { ProviderUsage } from "../../../shared/types.ts";
import { ageLabel } from "./usageAge.ts";
import { openCodePanelWindows } from "../../../shared/opencodePanel.ts";

export type KeyTone = "ok" | "warn" | "off" | "checking";

/** The card's verdict: what the stored key buys, and what a refused one needs. */
export function keyStatusChip(set: boolean | null, u: ProviderUsage | null): { tone: KeyTone; text: string } {
  if (set === null) return { tone: "checking", text: "Checking the key…" };
  if (!set) return { tone: "off", text: "No key: this PC only" };
  const note = u?.usageNote ?? "";
  if (/403|Budgets/i.test(note)) return { tone: "warn", text: "Key refused (403): add Budgets = Read" };
  if (note) return { tone: "warn", text: "Key set: the console could not be read" };
  return { tone: "ok", text: "Key set: whole plan" };
}

/** Which chip names where a reading came from: the card has room for three. */
export function readingSource(source: string | undefined): "this PC" | "console" | "key" | null {
  if (!source) return null;
  if (/key/i.test(source)) return "key";
  if (/console/i.test(source)) return "console";
  return "this PC";
}

/** The last reading as a row: the number, where it came from, and how old it is. */
export function lastReading(u: ProviderUsage | null, now = Date.now()): {
  value: string;
  tone: "ok" | "off";
  source: "this PC" | "console" | "key" | null;
  age: string | null;
} {
  if (!u) return { value: "No reading yet", tone: "off", source: null, age: null };
  // The same windows the panel and the top bar show: a fresh console or key reading, else the local estimate.
  const view = openCodePanelWindows(u, now);
  const source = view.estimate ? "this PC" : u.usageKey ? "key" : "console";
  const at = !view.estimate && u.calibration ? u.calibration.at : u.observedAt;
  const age = ageLabel(at, now) || null;
  if (u.available && view.windows.length) {
    const top = [...view.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0]!;
    return { value: `${top.usedPercent}% in the ${top.label} window`, tone: "ok", source, age };
  }
  if (u.available && u.spend) {
    return { value: `$${u.spend.usd.toFixed(2)} over ${u.spend.window}`, tone: "ok", source, age };
  }
  return { value: u.available ? "No quota windows or spend reported" : u.note ?? "No reading yet", tone: "off", source, age };
}
