/*
 * The limits of a read mark, shared because both sides enforce them: the server
 * refuses a batch that breaks any of them whole, and the browser (marksSync.ts)
 * splits and filters by the same numbers so nothing it holds is refused.
 */
import type { MarkKind } from "./types.ts";

export const MARK_KINDS: readonly MarkKind[] = ["pr", "inbox", "card"];
export const MARK_KEY_MAX = 200;
export const MARK_BATCH_MAX = 500;
/** Rows kept per kind. The browser keeps 400 pull requests; five times that
 *  covers several browsers' worth without the table growing forever. */
export const MARK_ROWS_MAX = 2000;
/*
 * What a key looks like, per kind. A key only has to be a string for SQLite,
 * but every browser writes the rows it is sent into a plain object, so a key
 * like "__proto__" or "toString" from any caller with answer scope is junk
 * every device then stores.
 *
 *   pr     `${repo || "?"}#n`, the key prNew.ts writes.
 *   inbox  a GitHub notification thread id, which is digits: ghinbox.ts
 *          refuses anything else before it reaches GitHub.
 *   card   a board's own id, in whatever shape the board uses; the length
 *          check is all it gets.
 *
 * The browser filters by the same patterns before sending, so a key the server
 * would refuse is left out rather than having its whole batch refused.
 */
export const MARK_KEY_SHAPE: Partial<Record<MarkKind, RegExp>> = { pr: /^[^\s#]+#\d+$/, inbox: /^\d+$/ };

/** Whether the server will take this key for this kind. */
export const markKeyFits = (kind: MarkKind, key: unknown): boolean =>
  typeof key === "string" && key.length >= 1 && key.length <= MARK_KEY_MAX && (MARK_KEY_SHAPE[kind]?.test(key) ?? true);
