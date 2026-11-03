/*
 * Which provider cells the usage bar has room for.
 *
 * A provider that is installed but has never reported anything is noise in a
 * 30px strip: "Codex — none" takes the same room as a real reading and answers
 * nothing. So a provider appears once this machine has seen one reading from
 * it — except Antigravity, whose whole state is "no reading" and which keeps a
 * dashed cell so the hole is visible rather than forgotten. A switch per
 * provider in Settings › Usage & budgets can hide any of them anyway. The seen
 * list is kept beside the switches, in this browser, because that is where the
 * strip is drawn.
 *
 * Default is on only for a provider that has a reading; an explicit off wins
 * over a later reading, which is the point of the switch.
 */
import type { ProviderUsage } from "../../../shared/types.ts";

const KEY = "agentglass.usageBar";
const SEEN = "agentglass.usageSeen";

export type UsageBarProvider = "anthropic" | "codex" | "opencode" | "antigravity";
export const USAGE_BAR_PROVIDERS: readonly { id: UsageBarProvider; label: string }[] = [
  { id: "anthropic", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode Go" },
  { id: "antigravity", label: "Antigravity" },
];

/** A provider whose whole state is "no reading" keeps its cell: a dashed hole
 *  is a state, and the sheet is where its note makes sense. */
const KEEPS_EMPTY_CELL: ReadonlySet<UsageBarProvider> = new Set(["antigravity"]);

type Map = Partial<Record<UsageBarProvider, boolean>>;

function read(key: string): Map {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const doc = JSON.parse(raw) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
    return doc as Map;
  } catch { return {}; }
}

function write(key: string, next: Map): void {
  try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode */ }
}

/** A reading that would put ink on the bar: a window or a dollar total. */
function hasReading(u: ProviderUsage): boolean {
  return u.available && (u.windows.length > 0 || !!u.spend);
}

export function everSeen(p: UsageBarProvider): boolean {
  return read(SEEN)[p] === true;
}

/** Remember every provider that has a reading now, so it stays known after the
 *  reading goes stale. Called on each poll, before the strip reads the list. */
export function noteReadings(rows: readonly ProviderUsage[]): void {
  const seen = read(SEEN);
  let changed = false;
  for (const u of rows) {
    if (!hasReading(u)) continue;
    if (seen[u.provider as UsageBarProvider]) continue;
    seen[u.provider as UsageBarProvider] = true;
    changed = true;
  }
  if (changed) write(SEEN, seen);
}

export function showInBar(p: UsageBarProvider): boolean {
  const explicit = read(KEY)[p];
  return explicit === undefined ? everSeen(p) || KEEPS_EMPTY_CELL.has(p) : explicit;
}

/** The switches as the card must draw them: the same answer the strip asks, so
 *  a switch cannot say off while a cell is on the bar. */
export function barSwitches(): Record<UsageBarProvider, boolean> {
  return Object.fromEntries(USAGE_BAR_PROVIDERS.map((p) => [p.id, showInBar(p.id)])) as Record<UsageBarProvider, boolean>;
}

export function setShowInBar(p: UsageBarProvider, on: boolean): void {
  write(KEY, { ...read(KEY), [p]: on });
}

/** The rows the strip draws: a provider hidden by the switch, or never read on
 *  this machine, does not take a cell. */
export function rowsInBar<T extends ProviderUsage>(rows: readonly T[]): T[] {
  return rows.filter((r) => showInBar(r.provider as UsageBarProvider));
}

/** Test seam: forget both the switches and what has been seen. */
export function __resetUsageBar(): void {
  try { localStorage.removeItem(KEY); localStorage.removeItem(SEEN); } catch { /* nothing stored */ }
}
