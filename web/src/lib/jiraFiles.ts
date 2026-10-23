/*
 * A Jira card's files, as plain decisions the pane draws from: what a drop is
 * worth, whether a file may be sent at all, where the pane asks this app for the
 * bytes, and the sentence that says what was done. The same limits the server
 * holds (server/src/jiraFiles.ts); here they only keep a mistake from costing a
 * request and an upload that was always going to be refused.
 */
import type { CardAttachment } from "../../../shared/providers.ts";
import { SERVER, withToken } from "./api.ts";

/** The most a file added here may be, in bytes. A bigger one is added in Jira. */
export const UPLOAD_MAX = 25 * 1024 * 1024;

/** The sentence that says why a file is not sent, or null when it may be. */
export function checkUpload(f: { name: string; size: number }): string | null {
  if (!f.size) return `${f.name || "That file"} is empty`;
  if (f.size > UPLOAD_MAX) return `${f.name || "That file"} is over ${UPLOAD_MAX / (1024 * 1024)} MB: add it in Jira`;
  return null;
}

/** Whether a drag carries files, as opposed to text or an address: only files are a drop target's business. */
export const dragHasFiles = (dt: { types?: readonly string[] | DOMStringList } | null | undefined): boolean => !!dt?.types && Array.from(dt.types as ArrayLike<string>).includes("Files");

/** The files of a drop, in the order they were dropped. */
export const droppedFiles = (dt: { files?: ArrayLike<File> } | null | undefined): File[] => (dt?.files ? Array.from(dt.files) : []);

/** Where the pane asks this app for a file: the route the server gave, on this app's own address, with its sign-in. */
export const viaApp = (path: string, extra = ""): string => (path ? withToken(`${SERVER}${path}${extra}`) : "");

/** The card's files with their addresses made whole; the routes the server named are all the page ever holds. */
export const withAddresses = (files: readonly CardAttachment[]): CardAttachment[] =>
  files.map((a) => ({ ...a, url: viaApp(a.url), ...(a.thumb ? { thumb: viaApp(a.thumb) } : {}) }));

/** The line left in the section's header after files were added: one name, or how many. */
export function addedSaid(names: readonly string[], failed: number): { text: string; warn?: boolean } {
  const done = names.length;
  if (!done) return { text: failed === 1 ? "Not added" : `${failed} not added`, warn: true };
  const what = done === 1 ? names[0]! : `${done} files`;
  return failed ? { text: `${what} added, ${failed} not`, warn: true } : { text: `${what} added` };
}
