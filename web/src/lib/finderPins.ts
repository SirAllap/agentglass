/*
 * The folders pinned to the finder's sidebar. Kept on this machine, in this
 * browser, as a list of absolute paths: a pin is where a person goes often, not
 * state anybody else needs. The ceiling is generous and only there so a bad
 * script cannot grow the sidebar without end.
 */
export const PIN_KEY = "agentglass.finder.pins";
export const PIN_MAX = 40;

/** Absolute paths only, once each, in the order stored; the root is not a place to pin. */
export function readPins(raw: string | null): string[] {
  if (!raw) return [];
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || !x.startsWith("/")) continue;
    const p = x.length > 1 ? x.replace(/\/+$/, "") : x;
    if (p === "/" || p === "" || out.includes(p)) continue;
    out.push(p);
    if (out.length >= PIN_MAX) break;
  }
  return out;
}

export function writePins(pins: readonly string[]): string {
  return JSON.stringify(pins);
}

/** Pin it, or unpin it if it is pinned. A full list refuses a new one and keeps what it has. */
export function togglePin(pins: readonly string[], path: string): string[] {
  if (pins.includes(path)) return pins.filter((p) => p !== path);
  return pins.length >= PIN_MAX ? [...pins] : [...pins, path];
}
