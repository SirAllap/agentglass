/**
 * 12- or 24-hour on the workspace notch.
 *
 * Defaults to whatever the machine's locale says rather than to 12h: most of
 * the world reads 24h, and a clock that starts wrong for the majority is a
 * setting everyone has to find before the strip is useful. The preference,
 * once set, wins over the locale — including the case where you want 24h on a
 * machine set to en-US, which is exactly the case that prompted this.
 */

const KEY = "agentglass.clock24";

/** What the locale would do, when nothing has been chosen. */
function localeIs24(): boolean {
  try {
    // `hour12` is undefined for locales that use neither convention explicitly,
    // so fall back to formatting an hour we can recognise: 13:00 stays 13 on a
    // 24h locale and becomes 1 on a 12h one.
    const opts = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions();
    if (typeof opts.hour12 === "boolean") return !opts.hour12;
    return /13/.test(new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2020, 0, 1, 13)));
  } catch { return false; }
}

export function clock24(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch { /* private mode */ }
  return localeIs24();
}

const listeners = new Set<() => void>();

export function setClock24(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* non-fatal */ }
  for (const fn of listeners) fn();
}

export function subscribeClock24(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
