/*
 * Container logs, followed instead of re-asked.
 *
 * The panel used to call `docker logs --tail 400` every three seconds and
 * repaint the lot. Two things were wrong with that. The obvious one is cost: a
 * timer that pays for a container's whole tail four hundred lines at a time,
 * forever, on the thread that also pumps the terminal's PTY — that is what the
 * "I type and the text appears half a second later" bug turned out to be the
 * first time round. The quiet one is correctness: anything a busy container
 * prints between two polls beyond the tail window is simply lost, and a log
 * viewer that drops lines without saying so is worse than no log viewer.
 *
 * So: one `docker logs --follow` per viewer, streamed. The rules that keep it
 * from becoming a leak are all here rather than in the route, because they are
 * the interesting part:
 *
 *   - the child is killed when the client goes away, including when it goes
 *     away by having its tab closed rather than by asking politely;
 *   - a hard cap on concurrent follows, so twelve containers clicked quickly
 *     cannot become twelve live processes;
 *   - the container ending is a message, not silence. "Exited" is the answer
 *     the viewer is waiting for.
 */
import { dockerBin } from "./docker.ts";

/** Container id or name, same rule the rest of the surface uses. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * How many follows may run at once.
 *
 * One per open panel is the honest case; the extras are the desktop window plus
 * the phone plus a second window. Past that, something is not closing its
 * streams and the right answer is to refuse loudly rather than to keep spawning.
 */
const MAX_FOLLOWS = 6;
let live = 0;

/** Test seam: the counter is process-wide by design. */
export function __liveFollowsForTest(): number { return live; }

export interface LogStreamResult {
  ok: boolean;
  /** Text stream, newline-delimited, ready to be a Response body. */
  stream?: ReadableStream<Uint8Array>;
  error?: string;
}

/**
 * Follow a container's log.
 *
 * `--tail` seeds the view with what is already there (so a stream is not an
 * empty box until something happens) and `--timestamps` is what lets the client
 * dim the stamp and read by time. Both halves of the container's output are
 * carried: plenty of images log to stderr and a viewer that shows only stdout
 * is a viewer that shows nothing for those.
 */
export function streamLogs(id: string, tail: number, signal?: AbortSignal): LogStreamResult {
  if (!ID_RE.test(id)) return { ok: false, error: "invalid container id" };
  if (live >= MAX_FOLLOWS) return { ok: false, error: "too many log streams are already open" };

  const n = Math.min(Math.max(Math.floor(tail) || 200, 1), 2000);
  const bin = dockerBin() ?? "docker";
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      live++;
      const enc = new TextEncoder();
      const say = (text: string) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(text)); } catch { /* the reader is gone */ }
      };
      const done = (why: string) => {
        if (closed) return;
        // The container ending is information. Silence here reads as "the panel
        // froze", which is the one thing this transport must never look like.
        say(`\n[agentglass] ${why}\n`);
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
        live = Math.max(0, live - 1);
        try { proc?.kill(); } catch { /* already gone */ }
      };

      try {
        proc = Bun.spawn([bin, "logs", "--follow", "--timestamps", "--tail", String(n), id], {
          stdout: "pipe", stderr: "pipe",
        });
      } catch (e) {
        done(`could not follow this container: ${String(e)}`);
        return;
      }

      const pump = async (side: ReadableStream<Uint8Array> | null) => {
        if (!side) return;
        const reader = side.getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end || closed) break;
          if (value) { try { controller.enqueue(value); } catch { break; } }
        }
      };
      // Both halves, concurrently. Interleaving is whatever the container's own
      // flushing produces, which is also what `docker logs` shows in a terminal.
      void Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);

      void proc.exited.then((code) => {
        done(code === 0 ? "the container stopped" : `docker logs ended (exit ${code})`);
      });

      // The client closing its tab is the common case, and it arrives here and
      // nowhere else: without this the follow outlives the viewer forever.
      signal?.addEventListener("abort", () => done("closed"), { once: true });
    },
    cancel() {
      closed = true;
      live = Math.max(0, live - 1);
      try { proc?.kill(); } catch { /* already gone */ }
    },
  });

  return { ok: true, stream };
}
