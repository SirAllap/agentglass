/**
 * Every key the pull request view answers to, in one list, so "can a keyboard
 * do everything" is a question a test can ask. Each entry names the file and a
 * piece of text that handler contains; test/pr-keymap.test.ts reads the file
 * and fails an entry whose handler was deleted. The decisions that are not
 * plain key matches (which card is next, which view a digit means) live here
 * as functions, away from the screen.
 *
 * Ceiling: this lists the keys, it does not press them. There is no renderer
 * in this project, so "the handler is in the source" is as far as it can go.
 */
export type Key = {
  scope: "cards" | "views" | "menus" | "picker" | "merge" | "files" | "controls" | "detail";
  keys: string;
  does: string;
  file: string;
  /** Text the handler contains; the test fails when the file no longer does. */
  anchor: string;
};

export const PR_KEYMAP: Key[] = [
  { scope: "cards", keys: "Tab", does: "Focus the next card", file: "src/components/PrCard.tsx", anchor: 'role="button" tabIndex={0} data-pr=' },
  { scope: "cards", keys: "Enter, Space", does: "Open the card docked", file: "src/components/PrCard.tsx", anchor: 'if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onOpen(); }' },
  { scope: "cards", keys: "j, k", does: "Move to the next or previous card", file: "src/components/TriageBoard.tsx", anchor: "cardStep(" },
  { scope: "cards", keys: "Shift+F10, ContextMenu", does: "Open the card menu", file: "src/components/PrCard.tsx", anchor: 'e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")' },
  { scope: "cards", keys: "/", does: "Focus the search", file: "src/components/PrPanel.tsx", anchor: 'e.key === "/" && !inInput' },
  { scope: "cards", keys: "Ctrl+F, Cmd+F", does: "Open the find bar on the board", file: "src/components/TriageBoard.tsx", anchor: 'e.key.toLowerCase() === "f"' },
  { scope: "views", keys: "Alt+1..9", does: "Apply the nth saved view", file: "src/components/PrViewsBar.tsx", anchor: "viewHotkey(e, altHeld)" },
  { scope: "views", keys: "Alt+Shift+1..4", does: "Open, Closed, Inbox, CI", file: "src/components/PrPanel.tsx", anchor: "viewForKey(" },
  { scope: "views", keys: "Esc", does: "Close the nearest layer, then the search text, then full screen, then the dock", file: "src/components/PrPanel.tsx", anchor: "escStep({" },
  { scope: "menus", keys: "Arrows, Home, End, Enter, Esc", does: "Walk, pick and close a menu", file: "src/components/AnchoredMenu.tsx", anchor: 'if (!isMenuKey(e.key)) return;' },
  { scope: "picker", keys: "Arrows, Home, End, Enter, Space, Backspace, Esc", does: "Walk, pick, unpick the last chip and close the people picker", file: "src/components/workspace/PeoplePicker.tsx", anchor: 'e.key === "ArrowDown" || e.key === "ArrowUp"' },
  { scope: "picker", keys: "Shift+Enter", does: "Follow or unfollow the highlighted person in the @ menu", file: "src/components/PrFilterBar.tsx", anchor: "focus.toggleFollow(flat[" },
  { scope: "picker", keys: "Shift+Enter, Delete, Shift+Delete", does: "Pin a recent or saved search, remove a recent one, clear recent", file: "src/components/PrFilterBar.tsx", anchor: "focus!.clearRecent" },
  { scope: "picker", keys: "Arrows, Enter, Tab, Esc", does: "Walk and pick in the search suggestions", file: "src/components/PrFilterBar.tsx", anchor: 'e.key === "Enter" || e.key === "Tab"' },
  { scope: "merge", keys: "Ctrl+Enter, Cmd+Enter", does: "Confirm the merge dialog", file: "src/components/MergeDialog.tsx", anchor: 'e.key === "Enter" && (e.metaKey || e.ctrlKey)' },
  { scope: "merge", keys: "Esc", does: "Cancel the merge dialog", file: "src/components/MergeDialog.tsx", anchor: 'e.key === "Escape"' },
  { scope: "files", keys: "j, k, Arrows", does: "Next or previous file", file: "src/components/PrPanel.tsx", anchor: 'k === "j" || e.key === "ArrowDown"' },
  { scope: "files", keys: "x", does: "Mark the file viewed and fold it", file: "src/components/PrPanel.tsx", anchor: 'else if (k === "x")' },
  { scope: "files", keys: "Enter", does: "Fold or unfold the file", file: "src/components/PrPanel.tsx", anchor: "toggleFold(sel)" },
  { scope: "files", keys: "n, p", does: "Next or previous hunk", file: "src/components/PrPanel.tsx", anchor: 'else if (k === "n")' },
  { scope: "files", keys: "[, ]", does: "Previous or next comment thread", file: "src/components/PrPanel.tsx", anchor: 'e.key === "]"' },
  { scope: "controls", keys: "Enter, Space", does: "Press a tab, segment, switch or chip", file: "src/components/workspace/Chrome.tsx", anchor: 'role="tab"' },
  { scope: "detail", keys: "Ctrl+Enter, Cmd+Enter", does: "Send the comment being written", file: "src/components/PrPanel.tsx", anchor: "void send(); }" },
];

/** The board's cards in reading order. Returns the index to focus; stops at the ends. */
export function cardStep(count: number, at: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (at < 0) return dir === 1 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, at + dir));
}

export type ViewId = "open" | "closed" | "inbox" | "ci";
const VIEWS: ViewId[] = ["open", "closed", "inbox", "ci"];

/**
 * Alt+Shift+1..4 name the four views in the order the bar draws them. Plain Alt+digit is the nth
 * saved view (viewHotkey), and both listen on window: sharing Alt+2..4 applied view N and jumped
 * to Closed/Inbox/CI in the same press. Other digits are not ours.
 */
export function viewForKey(e: { code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): ViewId | null {
  if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return null;
  const m = /^Digit([1-9])$/.exec(e.code);
  return m ? VIEWS[Number(m[1]) - 1] ?? null : null;
}
