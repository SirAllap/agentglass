/*
 * The app's monospace face.
 *
 * agentglass is a monospace UI end to end, so its one font choice is the mono
 * one — the same `--font-mono` the terminal, diffs and git graph already read.
 * Setting it on the root makes the whole cockpit follow. Every option ends in
 * the platform stack, so a face the machine doesn't have falls back cleanly
 * rather than breaking to a serif. "System" is no override at all.
 */
export interface UiFont { id: string; name: string; stack: string }

const FALLBACK = `"SF Mono", SFMono-Regular, ui-monospace, "Cascadia Code", Menlo, Consolas, "Liberation Mono", "JetBrainsMono Nerd Font Mono", monospace`;

export const UI_FONTS: UiFont[] = [
  { id: "", name: "System", stack: "" },
  { id: "jetbrains", name: "JetBrains Mono", stack: `"JetBrains Mono", "JetBrainsMono Nerd Font Mono", ${FALLBACK}` },
  { id: "fira", name: "Fira Code", stack: `"Fira Code", "FiraCode Nerd Font", ${FALLBACK}` },
  { id: "cascadia", name: "Cascadia Code", stack: `"Cascadia Code", "CaskaydiaCove Nerd Font", ${FALLBACK}` },
  { id: "plex", name: "IBM Plex Mono", stack: `"IBM Plex Mono", ${FALLBACK}` },
  { id: "source", name: "Source Code Pro", stack: `"Source Code Pro", ${FALLBACK}` },
];

const KEY = "agentglass-ui-font";

export function currentUiFont(): string {
  try { return localStorage.getItem(KEY) || ""; } catch { return ""; }
}

/** Apply the saved face to `--font-mono` on the root (or clear it for System).
 *  Call once at boot, and whenever the choice changes. */
export function applyUiFont(): void {
  const f = UI_FONTS.find((x) => x.id === currentUiFont());
  const root = document.documentElement.style;
  if (f && f.stack) root.setProperty("--font-mono", f.stack);
  else root.removeProperty("--font-mono");
}

export function setUiFont(id: string): void {
  try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch {}
  applyUiFont();
}
