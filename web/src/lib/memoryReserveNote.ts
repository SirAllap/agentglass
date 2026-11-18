// What the "Memory reserve" card says for a report: the words and the one
// button, decided here so the card only draws them and a test can read them.
import type { MemoryReserveReport } from "../../../shared/memoryReserve.ts";
import { humanSize } from "../../../shared/dockerSize.ts";

export interface MemoryReserveNote {
  tone: "ok" | "warn" | "off";
  badge: string;
  /** One line under the title: the state, in a sentence. */
  line: string;
  /** The button, or null when there is nothing to press. */
  action: { id: "apply" | "undo"; label: string } | null;
}

/** What the reserve is for, in one line. The card's description. */
export const MEMORY_RESERVE_WHAT =
  "Keeps the app's memory from being pushed to disk when the machine runs short, which is what froze it for seconds at a time.";

/**
 * Ceiling: the app's own unit is set by the app at every start, never by the
 * button. When it is the only level missing (a server started by hand, or a
 * start that could not set it) the card says so and offers nothing to press.
 */
export function memoryReserveNote(r: MemoryReserveReport): MemoryReserveNote {
  if (r.state === "not-applicable") return { tone: "off", badge: "Not applicable", line: r.why, action: null };
  const size = humanSize(r.want);
  if (r.state === "effective") {
    return { tone: "ok", badge: "Effective", line: `${size} is reserved at every level, from your session down to the app.`, action: { id: "undo", label: "Remove reserve" } };
  }
  const fixable = r.levels.filter((l) => l.owner !== "app" && r.missing.includes(l.unit));
  if (!fixable.length) {
    return { tone: "warn", badge: "Not effective", line: `The app's own unit (${r.missing.join(", ")}) holds no reserve. The app sets it when it starts: restart the app.`, action: null };
  }
  const needsPassword = fixable.some((l) => l.owner === "root");
  return {
    tone: "warn",
    badge: "Not effective",
    line: `Not reserved at: ${r.missing.join(", ")}. A level without it cancels the reserve of everything under it.`,
    action: { id: "apply", label: needsPassword ? `Reserve ${size} (asks your password once)` : `Reserve ${size}` },
  };
}
