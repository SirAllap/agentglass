/**
 * When the open-tools list needs a re-read with no event to cause it.
 *
 * The list moves on events, and every one of them pushes it: a Pre/PostToolUse, Stop or
 * SessionEnd write (ingest), a scope switch, a client connecting (its `initial` frame). What no event can
 * announce is time passing on a call that IS open: the stuck verdict has
 * minute-scale thresholds and its evidence is files growing on disk. That is the
 * only change without an event, so the safety tick exists only while a client is
 * connected and a call is open, every 60 s. An idle machine schedules nothing.
 */
/** Events that change the open-tools list: a call opens (Pre), closes (Post),
 *  or is cut off with no Post (Stop, SessionEnd). */
export function changesOpenTools(type: string): boolean {
  return type === "PreToolUse" || type.startsWith("PostToolUse") || type === "Stop" || type === "SessionEnd";
}

export const OPEN_TOOL_TICK_MS = 60_000;

export function nextOpenToolTick(clientCount: number, openCount: number): number | null {
  return clientCount > 0 && openCount > 0 ? OPEN_TOOL_TICK_MS : null;
}

export interface OpenToolsPusherDeps<T> {
  clientCount: () => number;
  read: () => T[];
  withEvidence: (open: T[]) => Promise<unknown>;
  /** `json` is `JSON.stringify(data)`, already built for the change check; reuse it. */
  send: (data: unknown, json: string) => void;
  setTimer: (fn: () => void, ms: number) => { unref?: () => void };
  onError?: (e: unknown) => void;
  /** Awaited before each read, so a push started inside a request reads after the answer is sent. */
  yieldFirst?: () => Promise<void>;
}

/** One scan at a time with a re-run queued; sends only a changed list; arms the
 *  safety tick only with a listener and an open call. */
export function createOpenToolsPusher<T>(d: OpenToolsPusherDeps<T>): () => Promise<void> {
  let lastCount = 0;
  let lastSent = "";
  let busy = false;
  let again = false;
  let armed = false;
  const arm = (openCount: number) => {
    if (armed) return;
    const ms = nextOpenToolTick(d.clientCount(), openCount);
    if (ms === null) return;
    armed = true;
    d.setTimer(() => { armed = false; void push(); }, ms).unref?.();
  };
  async function push(): Promise<void> {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        if (!d.clientCount()) return;
        if (d.yieldFirst) await d.yieldFirst();
        const open = d.read();
        if (!open.length && !lastCount) return;
        lastCount = open.length;
        arm(open.length);
        const data = await d.withEvidence(open);
        const sig = JSON.stringify(data);
        if (sig === lastSent) continue;
        lastSent = sig;
        d.send(data, sig);
      } while (again);
    } catch (e) {
      (d.onError ?? (() => {}))(e);
    } finally {
      busy = false;
    }
  }
  return push;
}
