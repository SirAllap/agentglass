// Servers the person marked "Keep" in Clean up. Keyed by program + folder +
// port (see keepKey), so a restarted service stays kept. Per browser profile:
// a preference about this machine's list, not data worth a route.
const KEY = "agx.cleanup.keep";

export function readKept(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : []);
  } catch { return new Set(); }
}

export function keep(key: string): Set<string> {
  const next = readKept().add(key);
  try { localStorage.setItem(KEY, JSON.stringify([...next])); } catch { /* private window: kept until reload */ }
  return next;
}
