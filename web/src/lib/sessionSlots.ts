/*
 * Session slots: the tmux sessions in the person's own order, so Ctrl+Alt+1
 * is always the same session whatever tmux's alphabetical list says.
 *
 * The order is a list of names kept in this browser (localStorage). A session
 * not in the list goes after the listed ones, oldest first, then by name; a name
 * in the list whose session is gone is skipped, and comes back to its place if
 * a session by that name is made again. Ceiling: the order is per machine
 * profile, not synced, and there is no setting an agent can write yet: an
 * agent that is asked to reorder has to do it through this dialog.
 */
const KEY = "agx.sessionOrder";

export function savedOrder(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  } catch { return []; }
}

export function saveOrder(names: readonly string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(names)); } catch { /* private mode: the order lasts this session */ }
}

export function slotOrder<T extends { name: string; created?: number }>(sessions: readonly T[], saved: readonly string[]): T[] {
  const at = new Map(saved.map((n, i) => [n, i] as const));
  const rank = (s: T) => at.get(s.name) ?? Number.MAX_SAFE_INTEGER;
  return [...sessions].sort((a, b) => rank(a) - rank(b) || (a.created ?? 0) - (b.created ?? 0) || a.name.localeCompare(b.name));
}

/** The order with `name` moved one place up (-1) or down (+1), as a full list of the shown names. */
export function moveSlot(shown: readonly string[], name: string, by: -1 | 1): string[] {
  const out = [...shown];
  const i = out.indexOf(name);
  const j = i + by;
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/**
 * Ctrl+Alt+1..9: the session in that slot. `code`, not `key`, for the same
 * reason as Alt+digit: the key a layout types under a modifier is not a digit
 * everywhere.
 */
export function ctrlAltDigit(e: { code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number | null {
  if (!e.altKey || !e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const m = /^Digit([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : null;
}
