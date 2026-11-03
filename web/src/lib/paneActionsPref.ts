/*
 * How the bar under each pane shows up: edge line, summary strip, always open,
 * or not at all. The decisions (default, order) live in lib/paneChip.ts.
 *
 * The first life of this setting was one key, `agentglass.term.paneActions`,
 * holding "off" or nothing. That key is still read — "off" stays off — so an
 * update never turns a bar back on for somebody who had turned it off. The
 * choice now lives under its own key.
 *
 * A machine that has never chosen gets a default that depends on its history,
 * and that history has to be read BEFORE the app writes anything of its own to
 * storage: see `settlePaneBarMode`, which main.tsx runs first of all and which
 * writes the answer down so it is the same on every later launch.
 */
import { defaultPaneBarMode, PANE_BAR_MODES, type PaneBarMode } from "./paneChip.ts";

const MODE_KEY = "agentglass.term.paneBar";
const OLD_KEY = "agentglass.term.paneActions";

export type PaneActionsMode = PaneBarMode;

/** Anything this app stored before today: one `agentglass.` key is enough. */
function hadState(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith("agentglass.")) return true;
  } catch { /* private mode: nothing was stored, so nothing is prior */ }
  return false;
}

function stored(): PaneBarMode | null {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if ((PANE_BAR_MODES as readonly string[]).includes(v ?? "")) return v as PaneBarMode;
    // The old key: "off" was the only value it ever held.
    if (localStorage.getItem(OLD_KEY) === "off") return "off";
  } catch { /* private mode */ }
  return null;
}

/** Decide once, write it down. Idempotent: an existing choice is never touched. */
export function settlePaneBarMode(): PaneBarMode {
  const have = stored();
  if (have) return have;
  const mode = defaultPaneBarMode(hadState());
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode: asked again next time */ }
  return mode;
}

/** What is chosen, or what the machine's history would choose. Reading writes nothing: `settlePaneBarMode` is the one write, at launch. */
export function paneActionsMode(): PaneBarMode {
  return stored() ?? defaultPaneBarMode(hadState());
}

const listeners = new Set<() => void>();

export function setPaneActionsMode(mode: PaneBarMode): void {
  try { localStorage.setItem(MODE_KEY, mode); localStorage.removeItem(OLD_KEY); } catch { /* private mode */ }
  for (const fn of listeners) fn();
}

export function subscribePaneActions(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/*
 * What the Edge line looks like: the thin line it always was, or a small
 * chevron tab centred on the pane's foot. Same colour, same hover, same keys.
 */
export type PaneMarker = "line" | "arrow";
const MARKER_KEY = "agentglass.term.paneMarker";

export function paneMarker(): PaneMarker {
  try { return localStorage.getItem(MARKER_KEY) === "arrow" ? "arrow" : "line"; } catch { return "line"; }
}

export function setPaneMarker(m: PaneMarker): void {
  // The default is an absent key, like every other preference here.
  try { if (m === "line") localStorage.removeItem(MARKER_KEY); else localStorage.setItem(MARKER_KEY, m); } catch { /* private mode */ }
  for (const fn of listeners) fn();
}
