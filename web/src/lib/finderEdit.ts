// What the Finder's Editing tab decides, away from the screen. The tab is nvim
// itself, in a bench session of its own inside the preview (FinderNvim); this is
// when it may start, when it must end, and when leaving needs a question.
import type { FileFacts } from "../../../shared/types.ts";

/** Mirror of server FINDER_EDIT_SLOT (bench.ts): a bench slot that is never a bench tab. */
export const FINDER_EDIT_SLOT = 89;

export type Editability = { ok: true } | { ok: false; why: string };

/** Text opens in nvim; anything else has nothing to edit. */
export function editability(f: Pick<FileFacts, "kind">): Editability {
  return f.kind === "text" ? { ok: true } : { ok: false, why: "Only text files are edited here" };
}

/** Which file the editor is on, or null when it is not running. */
export type EditorAt = { path: string } | null;

/**
 * What the one editor session does when the wanted state changes: nothing
 * running and one wanted starts it; leaving Editing, another file or the Finder
 * ends it (kill-session by its slot), so no tmux session outlives its use.
 */
export function editorLifecycle(prev: EditorAt, next: EditorAt): "keep" | "start" | "end" | "restart" {
  if (!prev && !next) return "keep";
  if (!prev && next) return "start";
  if (prev && !next) return "end";
  return prev!.path === next!.path ? "keep" : "restart";
}

/** Every way out of the editor that leaves its buffers behind. Each one asks when nvim holds unsaved changes. */
export const EXITS = ["row", "folder", "up", "history", "search-hit", "search-open", "finder-close", "preview-close", "external", "tab-away"] as const;
export type Exit = (typeof EXITS)[number];

/** `modified`: nvim says a buffer has unsaved changes. null: the editor is not running. */
export const exitDecision = (modified: boolean | null, _exit: Exit): "go" | "ask" => (modified ? "ask" : "go");
