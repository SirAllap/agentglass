/*
 * Read marks, shared between every device on one server.
 *
 * "Read up to" per pull request (prNew.ts) and the inbox's Saved and Done
 * shelves (inboxMarks.ts) live in this browser's localStorage, and that is
 * still where every panel reads them: it answers synchronously, it works with
 * the server down, and nothing on screen waits on a round trip to draw a
 * badge. The server is the layer the browsers agree through, not the source
 * they read from.
 *
 * So there are two directions, and they must never meet:
 *
 *   out  a local write hands its op to the sink this installs; ops are batched
 *        for FLUSH_MS and POSTed together, because "Mark all read" is one
 *        writeSeen per pull request and would otherwise be a request each.
 *   in   rows from GET /marks and from the `marks` frame are applied through
 *        applyServerSeen / applyServerShelves, which do not call the sink. If
 *        they did, every device would POST each mark straight back and the
 *        server would broadcast it again.
 *
 * The first time a browser syncs it sends everything it already holds: pull
 * request marks as they are (the server keeps the later of two, so resending
 * is safe), inbox shelves only where the server has nothing (`ifAbsent`), so a
 * browser that has been closed for a month cannot undo what another device
 * said since. A mark cleared on one device CAN come back from a second
 * browser's first sync, if that browser held an older mark and never synced
 * before. Once per browser, and accepted rather than solved.
 *
 * "Once per browser" is literal: the flag is one localStorage key, not one per
 * server. The same browser pointed at a second server, or at one whose
 * database was reset, never sends its marks there. There is no per-server
 * variant of the flag; that is a ceiling, and accepted.
 *
 * What is waiting to be sent is kept in localStorage too (QUEUE_KEY), and a
 * sync sends it before it asks the server for anything. A write made while the
 * server was away, followed by a reload, would otherwise be lost — and the
 * reload's full GET would then put the server's older copy over it.
 *
 * `card` marks exist on the server; nothing here writes one, because nothing on
 * the desk keeps a card's read state yet.
 */
import { api } from "./api.ts";
import type { MarkOp, MarkRow } from "../../../shared/types.ts";
import { MARK_BATCH_MAX, MARK_KINDS, MARK_ROWS_MAX, markKeyFits } from "../../../shared/marks.ts";
import { applyServerSeen, readSeen, setSeenSink } from "./prNew.ts";
import { applyServerShelves, doneIds, savedIds, setShelfSink } from "./inboxMarks.ts";

export interface MarksTransport {
  get(since?: number): Promise<{ marks: MarkRow[]; now: number }>;
  /** `needs` is the server's scope refusal: this device may not write. */
  post(ops: MarkOp[]): Promise<{ ok: boolean; needs?: string }>;
}

/** Set once this browser's own marks have reached the server. */
export const MIGRATED_KEY = "agx.marks.migrated";
/** Ops written here and not yet acknowledged by the server. */
export const QUEUE_KEY = "agx.marks.queue";
export const FLUSH_MS = 400;
/** How many unsent ops are kept. "Mark all read" over every pull request the
 *  browser remembers is 400; past this the oldest go, and the first sync's
 *  full resend is what covers a browser that was offline that long. */
const QUEUE_MAX = MARK_ROWS_MAX;
/** Ask again from a second before the last answer. A row written in the same
 *  millisecond as that answer would otherwise fall between the two; applying a
 *  row twice changes nothing, so the overlap costs nothing. */
const SINCE_MARGIN_MS = 1000;

let transport: MarksTransport | null = null;
/** Written here, not yet taken by a flush. */
let queue: MarkOp[] = [];
/** Taken by the flush in flight, not yet acknowledged. */
let sending: MarkOp[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let since = 0;
let syncing: Promise<void> | null = null;
let again = false;
/** Every flush waits for the one before it: two batches racing each other
 *  reach the server in either order, and for a shelf the later write is the
 *  one that must win. */
let flushed: Promise<boolean> = Promise.resolve(true);
/** The server said this device may not write. For the rest of the page: every
 *  later POST would be refused the same way. */
let readOnly = false;

const fits = (op: { kind: MarkOp["kind"]; key: string }): boolean => markKeyFits(op.kind, op.key);

function persist(): void {
  const all = sending.concat(queue);
  try {
    if (all.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(all.slice(-QUEUE_MAX)));
    else localStorage.removeItem(QUEUE_KEY);
  } catch { /* full or blocked: the in-memory queue still goes out */ }
}

function loadQueue(): MarkOp[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((o): o is MarkOp => !!o && typeof o === "object" && (MARK_KINDS as readonly string[]).includes(o.kind) && fits(o));
  } catch {
    // A corrupt queue is an empty one: the first sync's resend covers marks,
    // and nothing here is worth a page that will not load.
    return [];
  }
}

const enqueue = (op: MarkOp): void => {
  if (readOnly || !fits(op)) return;
  queue.push(op);
  if (queue.length > QUEUE_MAX) queue = queue.slice(-QUEUE_MAX);
  persist();
  if (!timer) timer = setTimeout(() => { void flushMarks(); }, FLUSH_MS);
};
// No flush on pagehide. The browser cancels an ordinary fetch as the page
// goes, and api.post has no way to ask for `keepalive`, so it sent next to
// nothing; the persisted queue is what carries a write across the close.

const realTransport: MarksTransport = {
  get: (s) => api.getMarks(undefined, s),
  post: (ops) => api.postMarks(ops),
};

/** Install the sinks and pick up what the last page left unsent. Once per
 *  page; the transport is a parameter for tests. */
export function startMarksSync(t: MarksTransport = realTransport): void {
  if (transport) return;
  transport = t;
  queue = loadQueue();
  setSeenSink(enqueue);
  setShelfSink(enqueue);
}

/** Undo startMarksSync — for tests, and the same as a page going away: the
 *  unsent queue stays in storage for the next one. */
export function stopMarksSync(): void {
  setSeenSink(null);
  setShelfSink(null);
  if (timer) clearTimeout(timer);
  transport = null; queue = []; sending = []; timer = null; since = 0;
  syncing = null; again = false; readOnly = false; flushed = Promise.resolve(true);
}

function refusedWriting(r: { needs?: string }): boolean {
  if (!r.needs) return false;
  readOnly = true;
  queue = []; sending = [];
  if (timer) { clearTimeout(timer); timer = null; }
  persist();
  return true;
}

/** One flush. True unless the network failed; what it could not send goes
 *  back on the queue for the next sync. A batch the server refused does not,
 *  or it would be sent forever. */
async function send(t: MarksTransport): Promise<boolean> {
  if (timer) { clearTimeout(timer); timer = null; }
  if (transport !== t || readOnly || !queue.length) return true;
  sending = queue;
  queue = [];
  while (sending.length) {
    let r: { ok: boolean; needs?: string };
    try {
      r = await t.post(sending.slice(0, MARK_BATCH_MAX));
    } catch {
      if (transport !== t) return false;
      queue = sending.concat(queue);
      sending = [];
      persist();
      return false;
    }
    if (transport !== t) return true;
    if (refusedWriting(r)) return true;
    sending = sending.slice(MARK_BATCH_MAX);
    persist();
  }
  return true;
}

/** Send what is queued now, after any flush already in flight. */
export function flushMarks(): Promise<boolean> {
  const t = transport;
  if (!t) return Promise.resolve(true);
  const p = flushed.then(() => send(t));
  flushed = p.catch(() => false);
  return p;
}

/** Server rows into the local cache, without echoing them back. */
export function applyMarkRows(rows: MarkRow[]): void {
  const pr = rows.filter((r) => r.kind === "pr");
  if (pr.length) applyServerSeen(pr);
  const inbox = rows.filter((r) => r.kind === "inbox");
  if (inbox.length) applyServerShelves(inbox);
}

/** Everything this browser holds, as the ops its first sync sends. */
export function localMarkOps(): MarkOp[] {
  const ops: MarkOp[] = [];
  for (const [key, seenAt] of Object.entries(readSeen())) ops.push({ kind: "pr", key, seenAt });
  // Done before saved: the server applies in order and `ifAbsent` keeps the
  // first, and a thread on both shelves locally is done (see setDone).
  for (const key of doneIds()) ops.push({ kind: "inbox", key, state: "done", ifAbsent: true });
  for (const key of savedIds()) ops.push({ kind: "inbox", key, state: "saved", ifAbsent: true });
  return ops.filter(fits);
}

function migrated(): boolean {
  try { return localStorage.getItem(MIGRATED_KEY) === "1"; } catch { return false; }
}

async function run(t: MarksTransport): Promise<void> {
  try {
    // Whatever this page, or the last one, failed to send goes first. If it
    // still cannot, the server's copy is older than this browser's, and taking
    // it now would undo those writes — so wait for the next connect.
    if (!(await flushMarks())) return;
    if (!readOnly && !migrated()) {
      const ops = localMarkOps();
      let ok = true;
      for (let i = 0; i < ops.length && ok; i += MARK_BATCH_MAX) {
        const r = await t.post(ops.slice(i, i + MARK_BATCH_MAX));
        ok = !refusedWriting(r) && r.ok;
      }
      if (ok) { try { localStorage.setItem(MIGRATED_KEY, "1"); } catch { /* asked again next boot */ } }
    }
    const r = await t.get(since || undefined);
    if (transport !== t) return;
    applyMarkRows(r.marks);
    since = Math.max(0, r.now - SINCE_MARGIN_MS);
  } catch {
    // Offline or refused. The local copy still answers; the next connect asks.
  }
}

/** On boot and on every reconnect: send what this browser owes, then take in
 *  what moved elsewhere. One at a time. A call that arrives while one runs may
 *  know of something the running GET was sent too early to see — a socket
 *  that opened after it — so it runs once more when that one is done, however
 *  many calls arrived meanwhile. */
export function syncMarks(): Promise<void> {
  const t = transport;
  if (!t) return Promise.resolve();
  if (syncing) { again = true; return syncing; }
  const p: Promise<void> = (async () => {
    do { again = false; await run(t); } while (again && transport === t);
  })().finally(() => { if (syncing === p) syncing = null; });
  syncing = p;
  return p;
}
