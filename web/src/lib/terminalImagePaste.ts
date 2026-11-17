/**
 * A picture pasted into a worker's pane.
 *
 * A worker runs behind a wall that hides the desktop's sockets, the display
 * server's among them, so the CLI inside cannot read the clipboard: Ctrl+V on
 * an image there answered "no image found" every time. Opening the socket
 * would hand the worker the whole clipboard and the screen, so the app reads
 * the image instead, on the person's own keypress, puts it in a file through
 * `/terminal/image` (the route the phone already uses) and types the path,
 * which every agent CLI accepts.
 *
 * Ceiling: workers only. A pane the person runs themselves reads the
 * clipboard on its own and keeps doing so; a path in place of an attachment
 * there would be a change nobody asked for.
 */

/** The worker rows: started by a chair or by the policy. A seat and the Lantern are the person's own. */
export function takesImagePaste(row: { role?: string; under?: string; startedBy?: unknown; worker?: unknown } | null | undefined): boolean {
  return !!row && !row.role && (!!row.under || !!row.startedBy || !!row.worker);
}

/** The first type of a clipboard item the server can sniff, or null when it holds no picture. */
export function pastedImageType(types: readonly string[]): string | null {
  return types.find((t) => t === "image/png" || t === "image/jpeg" || t === "image/gif" || t === "image/webp") ?? null;
}

/** What goes down the pty for a saved picture: one paste where the CLI asked for bracketed ones. */
export function pathPaste(file: string, bracketed: boolean): string {
  return bracketed ? `\x1b[200~${file}\x1b[201~` : file;
}

/** Base64 in slices: `String.fromCharCode(...bytes)` over a whole screenshot overflows the call stack. */
export function base64Of(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
