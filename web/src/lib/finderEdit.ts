// What the finder's own editor decides, away from the screen: which files it
// may edit, how line endings survive a text box, and whether closing needs a
// question. The server enforces the same cap and refuses the same files; this
// is what keeps the button from offering a save that would be refused.
import type { FileFacts } from "../../../shared/types.ts";

/** Mirror of server EDIT_CAP (browse.ts): what the preview already reads whole. */
export const EDIT_CAP = 256 * 1024;

export type Editability = { ok: true } | { ok: false; why: string };

export function editability(f: Pick<FileFacts, "kind" | "bytes" | "text" | "textTruncated">): Editability {
  if (f.kind !== "text") return { ok: false, why: "Only text files are edited here" };
  if (f.textTruncated || f.bytes > EDIT_CAP) return { ok: false, why: `Over ${EDIT_CAP / 1024} KB: this file is read-only here, Open in nvim edits it` };
  if (typeof f.text !== "string") return { ok: false, why: "The file could not be read" };
  if (f.text.includes("�")) return { ok: false, why: "Not valid UTF-8: editing it here would change bytes you did not touch" };
  return { ok: true };
}

/** A text box turns every line ending into \n; remember the file's own so a save does not rewrite them all. */
export function toEditor(text: string): { text: string; eol: "\n" | "\r\n" } {
  return text.includes("\r\n") ? { text: text.replace(/\r\n/g, "\n"), eol: "\r\n" } : { text, eol: "\n" };
}
export const fromEditor = (text: string, eol: "\n" | "\r\n"): string => (eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);

/** An open edit that has not been saved: what was typed, and the mtime it was read at. */
export interface Draft { text: string; saved: string; eol: "\n" | "\r\n"; mtime: number }
const drafts = new Map<string, Draft>();
export const getDraft = (path: string) => drafts.get(path);
export const setDraft = (path: string, d: Draft) => { if (d.text === d.saved) drafts.delete(path); else drafts.set(path, d); };
export const clearDraft = (path: string) => { drafts.delete(path); };
export const dirtyPaths = (): string[] => [...drafts.keys()];

/** Every way out of the editor that leaves its text behind. Each one asks when anything is unsaved. */
export const EXITS = ["row", "folder", "up", "history", "search-hit", "search-open", "finder-close", "preview-close", "done"] as const;
export type Exit = (typeof EXITS)[number];
export const exitDecision = (dirty: number, _exit: Exit): "go" | "ask" => (dirty > 0 ? "ask" : "go");

type Saver = (path: string, text: string, mtime: number) => Promise<{ ok: boolean; mtime?: number; error?: string }>;
/** Save every open draft, stopping at the first that is refused (a conflict, a cap): what was saved stays saved, the rest stays a draft. */
export async function saveDrafts(save: Saver): Promise<{ ok: true } | { ok: false; path: string; error: string }> {
  for (const [path, d] of [...drafts]) {
    let r: Awaited<ReturnType<Saver>>;
    try { r = await save(path, fromEditor(d.text, d.eol), d.mtime); } catch { return { ok: false, path, error: "the server did not answer" }; }
    if (!r.ok) return { ok: false, path, error: r.error ?? "the file could not be saved" };
    drafts.delete(path);
  }
  return { ok: true };
}
