/*
 * The keys the Polaris view answers to, in one list, so "does every menu have a
 * key" is a question a test can ask. Each entry names the file and a piece of
 * the handler; test/polaris-keys.test.ts fails an entry whose handler was
 * deleted. Ceiling: this lists the keys, it does not press them.
 */
export interface PolarisKey {
  keys: string;
  does: string;
  file: string;
  /** Text the handler contains; the test fails when the file no longer does. */
  anchor: string;
}

export const POLARIS_KEYMAP: readonly PolarisKey[] = [
  { keys: "Shift+F10, ContextMenu", does: "Open the stage menu", file: "src/components/polaris/PolarisView.tsx", anchor: 'e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")' },
  { keys: "Alt+1..6", does: "Jump to a block", file: "src/components/polaris/PolarisView.tsx", anchor: "tabAt(e)" },
  { keys: "Arrows, Home, End, Enter", does: "Walk, pick and close the stage menu", file: "src/components/ContextMenu.tsx", anchor: 'role="menuitem"' },
  { keys: "Esc", does: "Close the stage menu, then the example", file: "src/components/polaris/PolarisView.tsx", anchor: 'e.key === "Escape" && info' },
];

/** The label each entry of the stage menu carries, so the menu and this list cannot drift. */
export const TAB_KEYS = { open: "↵" } as const;

/** The block an Alt+digit names, or null. Digit n is TAB n (1-based), so Alt+1 is Watching. */
export function tabAt(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): number | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (!/^[1-6]$/.test(e.key)) return null;
  return Number(e.key) - 1;
}
