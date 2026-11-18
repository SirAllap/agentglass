// The Terminal page's rows as plain data: section, row id, label, help.
// The page renders from this, and the tests read the same table, so a row
// cannot appear twice, lose its sentence or run past 14 words unnoticed.

export interface TerminalRowDef { id: string; section: string; label: string; help: string }

export const TERMINAL_SECTIONS = ["look", "mouse", "tabs", "history", "restore", "danger"] as const;

export const TERMINAL_ROWS: TerminalRowDef[] = [
  { id: "terminal.renderer", section: "look", label: "Terminal renderer", help: "Picks how text is drawn; Compatibility is slowest but always works." },
  { id: "terminal.font", section: "look", label: "Font", help: "Picks the typeface every terminal uses." },
  { id: "terminal.fontSize", section: "look", label: "Font size", help: "Changes every open terminal at once." },
  { id: "terminal.lineHeight", section: "look", label: "Line height", help: "Sets the space between rows; 1 keeps box lines solid." },
  { id: "terminal.cursor", section: "look", label: "Cursor", help: "Sets the shape that marks where you type." },
  { id: "terminal.paneBar", section: "look", label: "Pane bar", help: "Sets how the bar under each pane shows its branch and pull request." },
  { id: "terminal.focusFollowsMouse", section: "mouse", label: "Focus follows mouse", help: "A pane takes focus when the pointer enters it." },
  { id: "terminal.copyOnSelect", section: "mouse", label: "Copy on select", help: "Puts the selected text on the clipboard at once." },
  { id: "terminal.rightClickPaste", section: "mouse", label: "Right-click to paste", help: "Right-click pastes, and Ctrl+right-click opens the menu." },
  { id: "terminal.paneBarMarker", section: "tabs", label: "Pane bar marker", help: "Sets the mark that shows which pane the bar belongs to." },
  { id: "terminal.tabGroups", section: "tabs", label: "Group tabs by project", help: "Off puts every tab in one row." },
  { id: "terminal.tabGroupRules", section: "tabs", label: "Group by name", help: "Sends tabs whose name starts with a prefix to a group." },
  { id: "terminal.scrollback", section: "history", label: "Scrollback", help: "Sets how many lines each terminal remembers." },
  { id: "terminal.wordSeparators", section: "history", label: "Word separators", help: "Sets where a double-click stops; empty takes the whole line." },
  { id: "terminal.benchButton", section: "history", label: "Floating button", help: "Chooses when the button shows." },
  { id: "terminal.benchLinks", section: "history", label: "Open PR and card links on the bench", help: "Opens a clicked pull request or card beside the terminal." },
  { id: "terminal.otherLinks", section: "history", label: "Open web links in", help: "Chooses where other web links open." },
  { id: "terminal.noteEditor", section: "history", label: "Note editor", help: "Neovim needs nvim installed; otherwise the built-in editor opens." },
  { id: "tmux.restore", section: "restore", label: "Restore the layout", help: "Brings your windows and panes back after a restart." },
  { id: "tmux.resume", section: "restore", label: "Resume mode", help: "Chooses how agents come back after a restart." },
  { id: "tmux.layoutSkipped", section: "restore", label: "Layout left alone", help: "The app restarted too often, so it skipped the restore." },
  { id: "tmux.lastCapture", section: "restore", label: "Last layout capture", help: "The restore rebuilds from this saved layout." },
  { id: "tmux.reset", section: "danger", label: "Reset tmux to defaults", help: "Clears your tmux settings and restarts the engine; agents keep their chats." },
];
