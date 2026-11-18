/**
 * OSC 52: a program asking the terminal to put text on the clipboard.
 *
 * A worker runs behind a wall that hides the display server's sockets, so the
 * agent CLI inside cannot call wl-copy itself; it writes `ESC ] 52 ; c ; <base64> BEL`
 * and says "copied N chars" as soon as it has written it. xterm drops OSC 52
 * unless a handler is registered, so the text went nowhere. A pane the person
 * runs themselves copies by its own means and never needed this.
 */

/** The text of an OSC 52 write, or null for a query ("?"), a clear, or bad base64. Data is what follows `52;`. */
export function osc52Text(data: string): string | null {
  const semi = data.indexOf(";");
  if (semi < 0) return null;
  const b64 = data.slice(semi + 1);
  if (!b64 || b64 === "?") return null;
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch { return null; }
}
