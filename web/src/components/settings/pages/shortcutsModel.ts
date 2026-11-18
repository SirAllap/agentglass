// What the Shortcuts page holds, as plain data. Per-view and per-action key rows
// come from lib/keybindings.ts; these are the page's own fixed rows and copy.
import type { SectionKind } from "../shell/shellRules.ts";

export interface ShortcutsRowDef { label: string; help: string }
export interface ShortcutsSectionDef { id: string; title: string; kind: SectionKind; rows: ShortcutsRowDef[] }

export const SHORTCUTS_PURPOSE = "See and change the keys that move you around.";

export const SHORTCUTS_SECTIONS: ShortcutsSectionDef[] = [
  { id: "views", title: "Views", kind: "normal", rows: [
    { label: "Why some views have two keys", help: "A chord works anywhere; a single key works only on Starboard." },
  ] },
  { id: "actions", title: "Actions", kind: "normal", rows: [] },
  { id: "shell", title: "Even inside a shell", kind: "normal", rows: [] },
  { id: "danger", title: "Danger zone", kind: "danger", rows: [
    { label: "Reset to defaults", help: "Puts every key on this page back to how it shipped." },
  ] },
];
export const VIEW_KEY_HELP = "A chord works anywhere; a single key works only on Starboard.";
export const SHELL_INTRO = "Combinations the terminal gives up so they reach the app.";
export const ACTIONS_INTRO = "Single keys that would type into a shell, so they stay out of terminals.";
