/**
 * The retained scene of every live panel, and the one door it goes out by.
 *
 * A plugin sends operations (`POST /plugin/self/panel/<id>/ops`); this module
 * checks who may send and how much, applies them with the reducer in
 * shared/pluginCanvas.ts, keeps the scene, and hands what changed to the
 * windows that asked to see that panel. The plugin never holds a socket to a
 * window and a window never holds one to a plugin.
 *
 * WHAT GOES WHERE. The shared `/stream` socket reaches read-scope phones and
 * carries only "look again" pings on purpose. A drawn scene is the desk's
 * (`/plugins/panels` is FULL_GET, and a plugin's own token is refused there by
 * kind), so its content leaves by ONE private WebSocket, `/plugins/panels/live`,
 * shared by every panel a window has open. One socket, not one stream per
 * panel: an HTTP/1 stream takes one of the six connection slots a browser
 * gives the host, and a plugin may declare eight panels.
 *
 * WHAT IS KEPT. The scene, a `version` the server owns (+1 per applied batch)
 * and an `epoch` that changes whenever the scene starts over (the plugin
 * stopped, was removed, or cleared its token). No operation log: a window that
 * missed something gets a snapshot, not a replay. The plugin's own `seq` only
 * lets it retry a batch it is not sure arrived.
 */
import { CANVAS_LIMITS, applyOps, sizeOf, type CanvasFrame, type CanvasOp, type CanvasScene } from "../../shared/pluginCanvas.ts";
import type { Contributes } from "../../shared/pluginUi.ts";

// ---------------------------------------------------------------- limits

/** Operations a plugin may send per second on average, and the burst it may
 *  spend at once. A request costs at least 1 even when it is empty or refused:
 *  a loop of invalid batches must not be free. */
export const OPS_PER_SECOND = 60;
export const OPS_BURST = 200;
/** How often a window hears about changes: many ops are one frame. */
export const FLUSH_MS = 100;
/** A socket buffered past this is not keeping up: it gets a fresh snapshot
 *  instead of the frames it missed. */
export const SOCKET_BACKLOG_BYTES = 256 * 1024;
export const SUBSCRIPTIONS_PER_SOCKET = 16;
/** One coalesced frame never grows past this many bytes of operations, nor
 *  past one batch of them: the window replays a frame as a batch. */
export const FRAME_BYTES = 256 * 1024;

interface Bucket { tokens: number; at: number }
const buckets = new Map<string, Bucket>();

/** Spend `cost` tokens (at least 1). `retryAfterMs` says when that much would
 *  be available again. */
export function takeOps(plugin: string, cost: number, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
  const need = Math.max(1, cost);
  let b = buckets.get(plugin);
  if (!b) buckets.set(plugin, (b = { tokens: OPS_BURST, at: now }));
  b.tokens = Math.min(OPS_BURST, b.tokens + ((now - b.at) / 1000) * OPS_PER_SECOND);
  b.at = now;
  if (b.tokens >= need) { b.tokens -= need; return { ok: true }; }
  // Charged even when refused: asking again straight away must not be a
  // free way to keep a plugin's budget at the ceiling.
  const short = need - b.tokens;
  b.tokens = Math.max(0, b.tokens - 1);
  return { ok: false, retryAfterMs: Math.ceil((short / OPS_PER_SECOND) * 1000) };
}

/**
 * Read a JSON body without ever holding more than `max` bytes of it.
 *
 * `req.json()` reads all of it and parses it on the server's one thread, the
 * same thread that answers a permission gate; the only cap before this was
 * Bun's 32 MB `maxRequestBodySize`. The declared length is checked first, and
 * a body that lies about it (or has none, chunked) is cut off as soon as it
 * passes `max`, before a byte of it is parsed.
 */
export async function readBoundedJson(req: Request, max: number): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string }> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return { ok: false, status: 413, error: `body is over ${max} bytes` };
  const reader = req.body?.getReader();
  if (!reader) return { ok: false, status: 400, error: "invalid json" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { void reader.cancel().catch(() => {}); return { ok: false, status: 413, error: `body is over ${max} bytes` }; }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.byteLength; }
  try { return { ok: true, value: JSON.parse(new TextDecoder().decode(buf)) }; } catch { return { ok: false, status: 400, error: "invalid json" }; }
}

// ---------------------------------------------------------------- scenes

interface Canvas { epoch: number; version: number; scene: CanvasScene; lastSeq: number | null }
const canvases = new Map<string, Map<string, Canvas>>();
let epochs = 0;

const keyOf = (plugin: string, panel: string) => `${plugin}\u0000${panel}`;

export type CanvasSnapshot = { epoch: number; version: number; scene: CanvasScene };

export function canvasSnapshot(plugin: string, panel: string): CanvasSnapshot {
  const c = canvases.get(plugin)?.get(panel);
  return c ? { epoch: c.epoch, version: c.version, scene: c.scene } : { epoch: 0, version: 0, scene: [] };
}

export type CanvasResult = { ok: true; epoch: number; version: number; applied: boolean } | { ok: false; error: string };

/** Only a panel the manifest declared as a canvas: the manifest is what the
 *  person approved, not the request. */
export function isCanvasPanel(c: Contributes, panel: string): boolean {
  return !!c.panels?.some((p) => p.id === panel && p.canvas === true);
}

export type OpsReply = { status: number; body: Record<string, unknown> };

/**
 * One request of operations, start to finish: the declared panel and the
 * token bucket come BEFORE the body is read, the body is read with a ceiling
 * (parsing is the expensive part), and the plugin is asked about again after
 * it arrives. `stillSelf` answers "is this request's token still this
 * plugin's": a plugin stopped while its body was on the wire (token revoked,
 * scene dropped) must not put a scene back.
 */
export async function handleCanvasOps(plugin: string, c: Contributes, panel: string, req: Request, stillSelf: () => boolean): Promise<OpsReply> {
  if (!isCanvasPanel(c, panel)) return { status: 400, body: { ok: false, error: notCanvas(panel) } };
  const slow = (retryAfterMs: number): OpsReply => ({ status: 429, body: { ok: false, error: "too many operations; slow down", retryAfterMs } });
  const first = takeOps(plugin, 1);
  if (!first.ok) return slow(first.retryAfterMs);
  const raw = await readBoundedJson(req, CANVAS_LIMITS.bodyBytes);
  if (!raw.ok) return { status: raw.status, body: { ok: false, error: raw.error } };
  const n = Array.isArray((raw.value as { ops?: unknown } | null)?.ops) ? (raw.value as { ops: unknown[] }).ops.length : 0;
  // The first token paid for the request; the rest pay for the batch.
  if (n > 1) { const rest = takeOps(plugin, n - 1); if (!rest.ok) return slow(rest.retryAfterMs); }
  if (!stillSelf()) return { status: 403, body: { ok: false, error: "this plugin was stopped" } };
  const r = applyCanvasOps(plugin, c, panel, raw.value);
  return { status: r.ok ? 200 : 400, body: r };
}

const notCanvas = (panel: string) => `panel "${panel}" is not declared as a canvas in this plugin's manifest`;

export function applyCanvasOps(plugin: string, c: Contributes, panel: string, body: unknown): CanvasResult {
  if (!isCanvasPanel(c, panel)) return { ok: false, error: notCanvas(panel) };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be {ops}" };
  const b = body as { ops?: unknown; seq?: unknown };
  if (b.seq !== undefined && (typeof b.seq !== "number" || !Number.isInteger(b.seq) || b.seq < 0 || b.seq > Number.MAX_SAFE_INTEGER)) return { ok: false, error: "seq must be a whole number" };
  let m = canvases.get(plugin);
  if (!m) canvases.set(plugin, (m = new Map()));
  let cv = m.get(panel);
  // A retried batch: the plugin did not hear the answer and sends the same
  // seq again. Said "applied" so it stops, and not applied twice.
  if (cv && typeof b.seq === "number" && cv.lastSeq === b.seq) return { ok: true, epoch: cv.epoch, version: cv.version, applied: false };
  const r = applyOps(cv?.scene ?? [], b.ops);
  if (!r.ok) return { ok: false, error: r.error };
  if (!cv) m.set(panel, (cv = { epoch: ++epochs, version: 0, scene: [], lastSeq: null }));
  cv.scene = r.value.scene;
  cv.version += 1;
  cv.lastSeq = typeof b.seq === "number" ? b.seq : null;
  queueFrame(plugin, panel, cv, r.value.ops);
  return { ok: true, epoch: cv.epoch, version: cv.version, applied: true };
}

/** A plugin that stopped, was removed, or lost its token leaves nothing a
 *  successor under the same name would inherit. Windows are told. */
export function dropCanvases(plugin: string): void {
  const had = canvases.get(plugin);
  canvases.delete(plugin);
  buckets.delete(plugin);
  for (const k of [...pending.keys()]) if (k.startsWith(`${plugin}\u0000`)) pending.delete(k);
  for (const h of handles) h.gone(plugin, had ? [...had.keys()] : []);
}

// ---------------------------------------------------------------- the socket

export interface CanvasSocket {
  send(text: string): unknown;
  /** Bytes waiting to go out; the socket's own backpressure. */
  buffered(): number;
}

/** Which panels exist and are live: wired by index.ts from the plugin
 *  registry, so this module imports no plugin code. */
let resolve: (plugin: string, panel: string) => { canvas: boolean; running: boolean } = () => ({ canvas: false, running: false });
export function setCanvasResolver(fn: typeof resolve): void { resolve = fn; }

interface Pending { epoch: number; from: number; to: number; ops: CanvasOp[]; bytes: number; json?: string }
const pending = new Map<string, Pending>();
let timer: ReturnType<typeof setTimeout> | null = null;

function queueFrame(plugin: string, panel: string, cv: Canvas, ops: CanvasOp[]): void {
  const k = keyOf(plugin, panel);
  const bytes = sizeOf(ops);
  let p = pending.get(k);
  // Two batches that would make a frame the window cannot replay (over one
  // batch of operations, or over the byte cap) are not joined: what is
  // pending goes out first. Joining them is what made a busy board teleport.
  if (p && p.epoch === cv.epoch && (p.ops.length + ops.length > CANVAS_LIMITS.batchOps || p.bytes + bytes > FRAME_BYTES)) {
    flushCanvases();
    p = undefined;
  }
  if (p && p.epoch === cv.epoch) { p.to = cv.version; p.ops.push(...ops); p.bytes += bytes; }
  else pending.set(k, { epoch: cv.epoch, from: cv.version - 1, to: cv.version, ops: [...ops], bytes });
  if (!timer) { timer = setTimeout(flushCanvases, FLUSH_MS); (timer as { unref?: () => void }).unref?.(); }
}

/** Send what accumulated. Exported so a test does not have to wait a tick. */
export function flushCanvases(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  const batch = [...pending];
  pending.clear();
  for (const [k, p] of batch) {
    const [plugin, panel] = k.split("\u0000") as [string, string];
    for (const h of handles) h.deliver(plugin, panel, p);
  }
}

const handles = new Set<CanvasHandle>();

/** One window's socket. `message` takes what the window sent. */
export class CanvasHandle {
  /** What this window has: the epoch and version of the last snapshot or
   *  frame it was sent, so a frame that does not follow it becomes a snapshot. */
  private subs = new Map<string, { epoch: number; version: number; stale?: boolean }>();
  constructor(private sock: CanvasSocket) { handles.add(this); }

  private send(f: CanvasFrame, json: string = JSON.stringify(f)): void { try { this.sock.send(json); } catch { /* closing */ } }

  private snapshot(plugin: string, panel: string, running = resolve(plugin, panel).running): void {
    const s = canvasSnapshot(plugin, panel);
    this.subs.set(keyOf(plugin, panel), { epoch: s.epoch, version: s.version });
    this.send({ type: "snapshot", plugin, panel, ...s, running });
  }

  message(raw: string | Buffer): void {
    if (typeof raw !== "string" || raw.length > 512) return;
    let f: { type?: unknown; plugin?: unknown; panel?: unknown };
    try { f = JSON.parse(raw); } catch { return; }
    if (typeof f.plugin !== "string" || typeof f.panel !== "string") return;
    const k = keyOf(f.plugin, f.panel);
    if (f.type === "unsubscribe") { this.subs.delete(k); return; }
    if (f.type !== "subscribe") return;
    // Only a panel that is declared as a canvas by an enabled plugin. Anything
    // else is answered as an empty, stopped scene rather than an error: the
    // window learns nothing about which plugins are installed that
    // `/plugins/panels` does not already tell it.
    if (!this.subs.has(k) && this.subs.size >= SUBSCRIPTIONS_PER_SOCKET) return;
    const known = resolve(f.plugin, f.panel);
    if (!known.canvas) {
      // Remembered, at an epoch no scene has: if the plugin is enabled later
      // and draws, this window is sent the scene instead of waiting for a
      // remount.
      this.subs.set(k, { epoch: -1, version: 0 });
      this.send({ type: "gone", plugin: f.plugin, panel: f.panel });
      return;
    }
    this.snapshot(f.plugin, f.panel, known.running);
  }

  deliver(plugin: string, panel: string, p: Pending): void {
    const have = this.subs.get(keyOf(plugin, panel));
    if (!have) return;
    // Anything that does not follow what this window has (a plugin that
    // restarted, a frame it missed, a backlog) is a snapshot, never a guess.
    // A socket that is not keeping up is sent NOTHING: a snapshot is up to
    // 128 KB and would be queued on top of what it cannot drain. It is marked,
    // and gets one scene when it drains (`drain`) or on the next flush that
    // finds it clear.
    if (this.sock.buffered() > SOCKET_BACKLOG_BYTES) { have.stale = true; return; }
    if (have.stale || have.epoch !== p.epoch || have.version !== p.from) { this.snapshot(plugin, panel); return; }
    have.version = p.to;
    // The same frame goes to every window that has this panel: one stringify.
    const frame: CanvasFrame = { type: "ops", plugin, panel, epoch: p.epoch, from: p.from, to: p.to, ops: p.ops };
    this.send(frame, (p.json ??= JSON.stringify(frame)));
  }

  /** The socket's buffer emptied: whatever it missed is one scene. */
  drain(): void {
    if (this.sock.buffered() > SOCKET_BACKLOG_BYTES) return;
    for (const [k, have] of this.subs) {
      if (!have.stale) continue;
      const [plugin, panel] = k.split("\u0000") as [string, string];
      this.snapshot(plugin, panel);
    }
  }

  gone(plugin: string, panels: string[]): void {
    for (const panel of panels) if (this.subs.has(keyOf(plugin, panel))) this.send({ type: "gone", plugin, panel });
  }

  close(): void { this.subs.clear(); handles.delete(this); }
}

/** For tests: forget everything, as a fresh process would. */
export function __resetCanvases(): void {
  canvases.clear(); buckets.clear(); pending.clear(); handles.clear();
  if (timer) { clearTimeout(timer); timer = null; }
}
