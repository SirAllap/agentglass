/*
 * Read marks, shared across devices.
 *
 * Every browser already keeps "read up to" per pull request and the Saved/Done
 * shelves of the inbox in its own localStorage, and still reads them from
 * there. This is the copy they sync through, so reading a pull request on one
 * machine clears its badge on the other.
 *
 * Two merge rules, one per shape of mark:
 *
 *   - `seenAt` (pr, card) only moves forward. Two windows on one pull request,
 *     or a stale tab writing after a fresh one, would otherwise bring back
 *     replies the reader already dealt with. `clear` is the one way backwards,
 *     and it is its own op for the same reason clearSeen is its own function on
 *     the web side (web/src/lib/prNew.ts).
 *   - an inbox shelf is last write wins. There is no order on "saved" and
 *     "done" to take a maximum of.
 *
 * `applyMarks` returns only the rows it actually changed, so a batch replayed
 * after a reconnect comes back empty and the route broadcasts nothing.
 */
import { db } from "./db.ts";
import type { MarkKind, MarkOp, MarkRow, PrTalkNote } from "../../shared/types.ts";
import { prMarkKey } from "../../shared/prUnread.ts";
import { MARK_KINDS, MARK_KEY_MAX, MARK_BATCH_MAX, MARK_ROWS_MAX, MARK_KEY_SHAPE } from "../../shared/marks.ts";

export { MARK_KINDS, MARK_KEY_MAX, MARK_BATCH_MAX, MARK_ROWS_MAX };

/**
 * How far ahead of the server's clock a mark may claim to be.
 *
 * A mark is "read up to", and it only moves forward — so one written in the
 * far future by a device with a wrong clock would bury every reply after it,
 * with no later write able to undo it short of an explicit clear. Five minutes
 * absorbs ordinary clock drift and nothing more.
 */
export const MARK_FUTURE_MS = 5 * 60_000;

const INBOX_STATES = new Set(["saved", "done", ""]);


const isKind = (k: unknown): k is MarkKind => typeof k === "string" && (MARK_KINDS as readonly string[]).includes(k);

/** The batch, checked whole. One bad op refuses all of them: a batch is one
 *  transaction, and half of one applied is a state nobody asked for. */
export function parseMarkOps(body: unknown): { ops: MarkOp[] } | { error: string } {
  const raw = (body as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(raw)) return { error: "ops must be an array" };
  if (raw.length > MARK_BATCH_MAX) return { error: `at most ${MARK_BATCH_MAX} ops per batch` };
  const ops: MarkOp[] = [];
  for (const o of raw as Record<string, unknown>[]) {
    if (!o || typeof o !== "object") return { error: "op must be an object" };
    const { kind, key } = o;
    if (!isKind(kind)) return { error: "kind must be pr, inbox or card" };
    if (typeof key !== "string" || key.length < 1 || key.length > MARK_KEY_MAX) {
      return { error: `key must be 1..${MARK_KEY_MAX} characters` };
    }
    if (MARK_KEY_SHAPE[kind] && !MARK_KEY_SHAPE[kind]!.test(key)) return { error: `not a ${kind} key` };
    if (kind === "inbox") {
      if (typeof o.state !== "string" || !INBOX_STATES.has(o.state)) return { error: "inbox state must be saved, done or empty" };
      ops.push({ kind, key, state: o.state as "saved" | "done" | "", ...(o.ifAbsent === true ? { ifAbsent: true } : {}) });
    } else if (o.clear === true) {
      ops.push({ kind, key, clear: true });
    } else {
      // At least 1 once floored: 0 means "cleared", and only `clear` says
      // that. Floored before the check, or 0.5 passes and lands as a clear.
      const seenAt = typeof o.seenAt === "number" && Number.isFinite(o.seenAt) ? Math.floor(o.seenAt) : 0;
      if (seenAt < 1) return { error: "seenAt must be a finite number of at least 1" };
      ops.push({ kind, key, seenAt });
    }
  }
  return { ops };
}

type Raw = { kind: MarkKind; key: string; seen_at: number; state: string; updated_at: number };
const toRow = (r: Raw): MarkRow => ({ kind: r.kind, key: r.key, seenAt: r.seen_at, state: r.state, updatedAt: r.updated_at });

/** Marks moved after `since` (server clock), oldest first. */
export function listMarks(kind?: MarkKind, since = 0): MarkRow[] {
  const s = Number.isFinite(since) ? since : 0;
  const rows = kind
    ? db.query<Raw, [string, number]>(`SELECT * FROM read_marks WHERE kind = ? AND updated_at > ? ORDER BY updated_at`).all(kind, s)
    : db.query<Raw, [number]>(`SELECT * FROM read_marks WHERE updated_at > ? ORDER BY updated_at`).all(s);
  return rows.map(toRow);
}

/*
 * Each statement's WHERE is the merge rule, so `changes` is the answer to "did
 * this op move anything" without a read before the write.
 */
const forward = db.query(
  `INSERT INTO read_marks (kind, key, seen_at, updated_at) VALUES ($kind, $key, $v, $now)
   ON CONFLICT(kind, key) DO UPDATE SET seen_at = excluded.seen_at, updated_at = excluded.updated_at
   WHERE excluded.seen_at > read_marks.seen_at`,
);
const clear = db.query(
  `UPDATE read_marks SET seen_at = 0, updated_at = $now WHERE kind = $kind AND key = $key AND seen_at <> 0`,
);
const shelf = db.query(
  `INSERT INTO read_marks (kind, key, state, updated_at) VALUES ($kind, $key, $state, $now)
   ON CONFLICT(kind, key) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
   WHERE excluded.state <> read_marks.state`,
);
const shelfIfAbsent = db.query(
  `INSERT INTO read_marks (kind, key, state, updated_at) VALUES ($kind, $key, $state, $now)
   ON CONFLICT(kind, key) DO NOTHING`,
);
const prune = db.query(
  `DELETE FROM read_marks WHERE kind = $kind AND key IN (
     SELECT key FROM read_marks WHERE kind = $kind ORDER BY updated_at DESC LIMIT -1 OFFSET $keep)`,
);
const one = db.query<Raw, [string, string]>(`SELECT * FROM read_marks WHERE kind = ? AND key = ?`);

/**
 * Whether a "talk" note is already accounted for by a read mark.
 *
 * A read mark is "seen up to", not "dismiss this one event" — so a remark is
 * already read once the pull request's `seenAt` is at or after it. Without
 * this, `noteTalk`'s latch (which only tracks the newest remark it has told a
 * listener about, never who has since read it) would re-announce a comment
 * that was already read on another device the next time something re-asks the
 * list — which prWatch.ts now does on a timer, with nobody at the PRs tab.
 */
export function talkAlreadyRead(note: Pick<PrTalkNote, "url" | "number" | "at">, rows: MarkRow[]): boolean {
  const at = Date.parse(note.at);
  if (!Number.isFinite(at)) return false;
  // The key the devices write, from the URL — not `note.repo`, which is
  // `owner/name` and matches no mark (those carry the host too).
  const key = prMarkKey(note);
  const row = rows.find((r) => r.kind === "pr" && r.key === key);
  return !!row && row.seenAt >= at;
}

/** Apply a validated batch in one transaction; the rows it changed, each once,
 *  as they stand afterwards. `now` is a parameter for the tests. */
export function applyMarks(ops: MarkOp[], now = Date.now()): MarkRow[] {
  return db.transaction((): MarkRow[] => {
    const moved = new Map<string, [MarkKind, string]>();
    const kinds = new Set<MarkKind>();
    for (const op of ops) {
      let n = 0;
      const base = { $kind: op.kind, $key: op.key, $now: now };
      if ("state" in op) {
        n = (op.ifAbsent ? shelfIfAbsent : shelf).run({ ...base, $state: op.state } as any).changes;
      } else if ("clear" in op) {
        n = clear.run(base as any).changes;
      } else {
        n = forward.run({ ...base, $v: Math.min(op.seenAt, now + MARK_FUTURE_MS) } as any).changes;
      }
      if (n > 0) { moved.set(`${op.kind}\0${op.key}`, [op.kind, op.key]); kinds.add(op.kind); }
    }
    for (const k of kinds) prune.run({ $kind: k, $keep: MARK_ROWS_MAX } as any);
    const out: MarkRow[] = [];
    for (const [kind, key] of moved.values()) {
      const r = one.get(kind, key);
      if (r) out.push(toRow(r));
    }
    return out;
  })();
}
