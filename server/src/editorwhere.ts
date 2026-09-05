/*
 * "Where is the cursor?"
 *
 * The editor pane draws a rail of the places a file changed, and the rail is
 * only a MAP if it knows where you are — scrolling in the editor should light
 * the place you landed in, not leave the highlight on whatever you pressed
 * last. Nothing in a terminal says that: the pty carries bytes, not a cursor.
 *
 * Neovim does, over its own socket. It is started with `--listen <path>` and
 * asked `line('.')` on demand; the client never sees the socket, only an opaque
 * id — a socket path from a client would be a way to talk to any nvim on the
 * machine, and this one is ours because we started it.
 *
 * Everything here degrades to "no idea": no nvim, an older one, a socket that
 * died with its window. The rail then behaves the way it did before any of this
 * existed, which is the point of asking rather than requiring.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** id → socket. Module-level: an editor outlives the request that opened it and
 *  is asked about many times. */
const sockets = new Map<string, { path: string; dir: string; at: number }>();

/** Sockets left by editors that ended without saying so. Half an hour is long
 *  past the life of a file somebody opened to look at. */
const STALE_MS = 30 * 60_000;

let seq = 0;

/** Make a socket for an editor about to start, and answer with the pair: the
 *  path to hand `--listen`, and the id to hand the client. */
export function newEditorSocket(): { id: string; path: string } {
  sweep();
  const dir = mkdtempSync(join(tmpdir(), "agx-nvim-"));
  const path = join(dir, "nvim.sock");
  const id = `ed${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  sockets.set(id, { path, dir, at: Date.now() });
  return { id, path };
}

/** The editor is gone; take its socket with it. */
export function dropEditorSocket(id: string): void {
  const held = sockets.get(id);
  if (!held) return;
  sockets.delete(id);
  try { rmSync(held.dir, { recursive: true, force: true }); } catch { /* already gone */ }
}

function sweep(): void {
  const now = Date.now();
  for (const [id, held] of sockets) if (now - held.at > STALE_MS) dropEditorSocket(id);
}

/**
 * Ask that editor where its cursor is.
 *
 * `--remote-expr` runs one expression in the running instance and prints the
 * answer; it cannot start one, so a dead socket is an error rather than a
 * second nvim appearing on the machine.
 */
export async function editorCursor(id: string, bin = "nvim"): Promise<{ ok: boolean; line?: number }> {
  const held = sockets.get(id);
  if (!held) return { ok: false };
  try {
    const proc = Bun.spawn([bin, "--server", held.path, "--remote-expr", "line('.')"], {
      stdout: "pipe", stderr: "ignore", stdin: "ignore",
    });
    const kill = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 1500);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(kill);
    if (code !== 0) return { ok: false };
    const line = Number(out.trim());
    return Number.isFinite(line) && line > 0 ? { ok: true, line } : { ok: false };
  } catch {
    return { ok: false };
  }
}
