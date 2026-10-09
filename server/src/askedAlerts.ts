/*
 * The notifications a person asked for, kept until they act on them.
 *
 * A PR watch they armed ("tell me when CI passes") is a promise, and the old
 * delivery broke it in two ways: the fire was acknowledged the moment a window
 * DREW it, so a reload a second later lost it; and nothing recorded whether
 * anybody had seen it or pressed it, so "did it ever tell me?" had no answer.
 *
 * So the row here lives until it is closed, not until it is shown. A window that
 * starts asks for the open ones and draws them again. Closing one answers it for
 * every window at once (a frame goes out), and the phone, which reads the same
 * frames, drops it too.
 *
 * One alert per EVENT. The key is the PR, the commit it was read at and the
 * verdict, so a re-poll of the same head finds the alert already here and says
 * nothing; a new push is a new head and is a new event.
 *
 * Ceiling: this holds the alert, not the decision to raise one. When a watch
 * fires is prNotifyWatch.ts's, and its timing is not touched here.
 */
import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { oneLine, type AskedAlert, type NotifyPayload } from "../../shared/notifyPayload.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS asked_alert (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  ok INTEGER NOT NULL,
  payload TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  seen_at INTEGER,
  acted_at INTEGER,
  closed_at INTEGER,
  os_error TEXT
);
`);

type Row = {
  id: string; key: string; ok: number; payload: string; fired_at: number;
  seen_at: number | null; acted_at: number | null; closed_at: number | null; os_error: string | null;
};

const toAlert = (r: Row): AskedAlert => ({
  id: r.id, key: r.key, ok: r.ok === 1, payload: JSON.parse(r.payload) as NotifyPayload,
  firedAt: r.fired_at, seenAt: r.seen_at, actedAt: r.acted_at, closedAt: r.closed_at, osError: r.os_error,
});

/** How many past alerts the audit keeps; older rows go on the next raise. */
export const AUDIT_KEEP = 50;

type Event = { type: "askedalert"; data: AskedAlert } | { type: "askedclosed"; data: { id: string } };
const listeners = new Set<(e: Event) => void>();
/** The server's broadcast subscribes here. */
export function subscribeAskedAlerts(fn: (e: Event) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
const emit = (e: Event) => { for (const fn of listeners) { try { fn(e); } catch { /* the row is kept: the next window restores it */ } } };

/**
 * Raise one. Returns the alert when this call made it, null when the same event
 * was already raised — which is the whole dedupe: a second poll, a second
 * window, a retry after a crash all land here and find the key taken.
 */
export function raiseAsked(i: { key: string; ok: boolean; payload: NotifyPayload; armedAt?: number }, now = Date.now()): AskedAlert | null {
  const id = randomUUID();
  /* The one way the same key is a NEW ask: the person armed the watch again after
     that alert was raised (pressing the bell again on a PR that is already
     green). Without this, re-arming on an unchanged head would be deduped into
     silence — the opposite of what pressing it means. */
  if (i.armedAt !== undefined) db.run(`DELETE FROM asked_alert WHERE key = ? AND fired_at < ? AND closed_at IS NOT NULL`, [i.key, i.armedAt]);
  const won = db.run(
    `INSERT OR IGNORE INTO asked_alert (id, key, ok, payload, fired_at) VALUES (?, ?, ?, ?, ?)`,
    [id, i.key, i.ok ? 1 : 0, JSON.stringify(i.payload), now],
  ).changes > 0;
  if (!won) return null;
  db.run(`DELETE FROM asked_alert WHERE closed_at IS NOT NULL AND id NOT IN
    (SELECT id FROM asked_alert ORDER BY fired_at DESC, rowid DESC LIMIT ?)`, [AUDIT_KEEP]);
  const a = get(id)!;
  emit({ type: "askedalert", data: a });
  return a;
}

function get(id: string): AskedAlert | null {
  const r = db.query<Row, [string]>(`SELECT * FROM asked_alert WHERE id = ?`).get(id);
  return r ? toAlert(r) : null;
}

/** Still waiting on the person, oldest first: what a window draws when it starts. */
export function openAsked(): AskedAlert[] {
  return db.query<Row, []>(`SELECT * FROM asked_alert WHERE closed_at IS NULL ORDER BY fired_at, rowid`).all().map(toAlert);
}

/** The last `n` raised, newest first, with when each was fired, seen and acted on. */
export function auditAsked(n = 20): AskedAlert[] {
  return db.query<Row, [number]>(`SELECT * FROM asked_alert ORDER BY fired_at DESC, rowid DESC LIMIT ?`).all(Math.max(1, Math.min(n, AUDIT_KEEP))).map(toAlert);
}

/** A window drew it. First draw only: a second window does not rewrite when it was first seen. */
export function markSeen(id: string, now = Date.now()): boolean {
  return db.run(`UPDATE asked_alert SET seen_at = ? WHERE id = ? AND seen_at IS NULL`, [now, id]).changes > 0;
}

/**
 * Take it down everywhere. `acted` is whether the person pressed its action
 * (open) rather than just closing it; the audit tells the two apart.
 */
export function closeAsked(id: string, acted: boolean, now = Date.now()): boolean {
  const won = db.run(
    `UPDATE asked_alert SET closed_at = ?, acted_at = CASE WHEN ? THEN COALESCE(acted_at, ?) ELSE acted_at END,
       seen_at = COALESCE(seen_at, ?) WHERE id = ? AND closed_at IS NULL`,
    [now, acted ? 1 : 0, now, now, id],
  ).changes > 0;
  if (won) emit({ type: "askedclosed", data: { id } });
  return won;
}

/** The OS popup could not be shown. Kept on the row and said in the log: the banner still stands. */
export function osFailed(id: string, reason: string): boolean {
  const why = oneLine(reason, 200) || "unknown";
  const won = db.run(`UPDATE asked_alert SET os_error = ? WHERE id = ?`, [why, id]).changes > 0;
  if (won) console.warn(`[asked-alerts] OS notification for ${id} not shown: ${why}`);
  return won;
}

/**
 * The HTTP surface, as data: the caller (index.ts) wraps it in its own `json`,
 * which is where CORS and the token check live. Null for a path that is not ours.
 */
export function handleAskedAlertRoute(method: string, pathname: string, body: Record<string, unknown>): { status: number; data: unknown } | null {
  if (pathname === "/alerts/asked" && method === "GET") return { status: 200, data: { ok: true, open: openAsked() } };
  if (pathname === "/alerts/asked/audit" && method === "GET") return { status: 200, data: { ok: true, audit: auditAsked() } };
  if (method !== "POST" || !pathname.startsWith("/alerts/asked/")) return null;
  const id = String(body.id ?? "");
  if (!id) return { status: 400, data: { ok: false, error: "which alert?" } };
  if (pathname === "/alerts/asked/seen") return { status: 200, data: { ok: markSeen(id) } };
  if (pathname === "/alerts/asked/close") return { status: 200, data: { ok: closeAsked(id, body.acted === true) } };
  if (pathname === "/alerts/asked/os-failed") return { status: 200, data: { ok: osFailed(id, String(body.reason ?? "")) } };
  return null;
}
