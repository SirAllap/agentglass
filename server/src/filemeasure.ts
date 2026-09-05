/*
 * How long a file is.
 *
 * The editor pane draws a strip of the whole file with a band per change, and
 * for that it needs one number. Reading the file to count its newlines is
 * cheaper than everything else on that screen and far cheaper than sending the
 * text back to throw it away — which is what asking `/files/read` for it would
 * be.
 *
 * The path may be absolute and outside the workspace, and that is deliberate:
 * a pull request's file is fetched to a temp copy precisely because it is not
 * in the checkout. It is held to the same rule the viewer is — in scope, or a
 * copy this server itself wrote — and nothing else is measurable.
 */
import { statSync } from "node:fs";
import { isViewTemp } from "./viewtemp.ts";
import { inScope } from "./config.ts";

/** Past this, the answer is the size rather than a count: a 40MB log is not a
 *  file anybody is reading in a pane with a rail down its side, and reading it
 *  to count newlines would block the server for as long as it takes. */
const MAX_BYTES = 8 * 1024 * 1024;

export async function measureFile(path: string): Promise<{ ok: boolean; lines?: number; error?: string }> {
  if (!path.startsWith("/")) return { ok: false, error: "that is not a path" };
  if (!inScope(path) && !isViewTemp(path)) return { ok: false, error: "that file is outside this project" };
  let size = 0;
  try { size = statSync(path).size; } catch { return { ok: false, error: "no such file" }; }
  if (size > MAX_BYTES) return { ok: false, error: "too big to measure" };
  try {
    const text = await Bun.file(path).text();
    // A file that does not end in a newline still has that last line.
    const lines = text.length ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
    return { ok: true, lines };
  } catch {
    return { ok: false, error: "could not read it" };
  }
}
