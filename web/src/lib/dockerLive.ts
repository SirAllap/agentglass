/*
 * The Docker panel's live connection: what to do with `GET /docker/live`.
 *
 * Docker says what changed, so nothing here asks on a timer. EventSource
 * reconnects by itself when the connection merely dropped; a refusal (401, the
 * server's cap on open feeds) closes it for good, and that case gets a retry of
 * our own with a growing wait. If the feed never comes, the panel keeps what it
 * fetched on open and on Refresh. It does not fall back to polling.
 */
import type { DockerLiveMessage, DockerLiveScope, DockerStat } from "../../../shared/types.ts";

export interface DockerLiveHandlers {
  /** A list changed: fetch it again. */
  onChanged?: (scope: DockerLiveScope) => void;
  /** One sample for every running container. */
  onStats?: (stats: DockerStat[]) => void;
  /** The daemon went away (the server keeps retrying). */
  onDown?: () => void;
  /** It is back. */
  onUp?: () => void;
  /** The connection came back after a gap: events in it were not seen, so fetch everything once. */
  onReconnect?: () => void;
}

const SCOPES = new Set<string>(["containers", "images", "volumes", "networks"]);

export function parseLive(data: unknown): DockerLiveMessage | null {
  let m: any;
  try { m = JSON.parse(String(data)); } catch { return null; }
  if (m?.kind === "changed" && SCOPES.has(m.scope)) return { kind: "changed", scope: m.scope };
  if (m?.kind === "stats" && Array.isArray(m.stats)) return { kind: "stats", stats: m.stats };
  if (m?.kind === "down" || m?.kind === "up") return { kind: m.kind };
  return null;
}

/** Wait before our own retry after a refusal: 1, 2, 4 … 30 seconds. */
export const liveBackoffMs = (fails: number): number => Math.min(30_000, 1000 * 2 ** Math.min(fails, 16));

export interface LiveDeps {
  EventSource?: typeof EventSource;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

/** Connect and keep connected. `url` null (the demo) connects to nothing. Returns the function that stops it. */
export function connectDockerLive(url: string | null, handlers: () => DockerLiveHandlers, deps: LiveDeps = {}): () => void {
  const ES = deps.EventSource ?? (typeof EventSource === "undefined" ? undefined : EventSource);
  const later = deps.setTimeout ?? setTimeout;
  const unlater = deps.clearTimeout ?? clearTimeout;
  if (!url || !ES) return () => {};

  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let fails = 0;
  let gap = false;

  const open = () => {
    timer = null;
    const mine = new ES(url);
    es = mine;
    mine.onopen = () => {
      fails = 0;
      if (gap) { gap = false; handlers().onReconnect?.(); }
    };
    mine.onmessage = (e) => {
      if (stopped) return;
      const m = parseLive(e.data);
      const h = handlers();
      if (!m) return;
      if (m.kind === "changed") h.onChanged?.(m.scope);
      else if (m.kind === "stats") h.onStats?.(m.stats);
      else if (m.kind === "down") h.onDown?.();
      else h.onUp?.();
    };
    mine.onerror = () => {
      gap = true;
      if (mine.readyState !== 2 || stopped) return;   // still CONNECTING: the browser retries it
      mine.close();
      timer = later(open, liveBackoffMs(fails++));
    };
  };
  open();

  return () => {
    stopped = true;
    if (timer) unlater(timer);
    timer = null;
    es?.close();
    es = null;
  };
}
