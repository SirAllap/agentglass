/*
 * WHAT THE WORKSPACE SWEEP READ, KEPT ON THIS MACHINE.
 *
 * ClickUp's API has no text search of any kind, so "which cards mention this
 * one" can only be answered by downloading the cards and looking inside them.
 * Measured against a real workspace: three hundred cards WITH their bodies take
 * about 45 seconds; the same question a minute later takes 33ms, because the
 * answer is still in memory. Restart the app and somebody pays the 45 seconds
 * again — which is exactly the moment a person is most likely to search.
 *
 * So the sweep writes down what it saw, and the search reads from here first.
 * Cold or warm, the first answer is a local query. The sweep still runs behind
 * it, so anything the index has not seen yet arrives a moment later; nothing
 * here decides what is true, it only decides what is fast.
 *
 * Read-only towards ClickUp, always: this module writes to a table on this
 * machine and never sends anything anywhere.
 */
import { db, shrinkFreePages } from "./db.ts";
import { setTimeoutAs, waitedFor } from "./loopwatch.ts";
import type { ProviderTask } from "../../shared/providers.ts";
import { cardRefsIn, mentionsCardId } from "../../shared/cardRef.ts";

/**
 * What the `body` column holds: the card ids the body names, not the body.
 *
 * The body is kept for one question, "which cards mention card N", and
 * nothing reads it back as text. Measured on a copy of a real database:
 * 10,218 cards held 301 MB of body (2,861 of them between 50 and 106 KB each)
 * against 28 MB of everything else about them, in a 946 MB file. That file is
 * read on the server's only thread, and after memory pressure it is re-read
 * from disk: stalls of 2 to 4.5 s with the thread waiting on the filesystem.
 * A third of it was text kept to answer a yes or no.
 *
 * A body that names no card is kept as one space, so "this card's body has
 * been read" still differs from "nobody read it yet" (the upsert below and
 * `indexed` both ask that).
 */
const kept = (body: string): string => (body ? cardRefsIn(body) || " " : "");

/** A card as the index holds it: the panel's own shape plus the body, which is
 *  the field the expensive read exists for. */
export interface IndexedCard extends ProviderTask { body?: string }

const upsert = db.query<never, [string, string, string, string, string, number, string, number]>(
  `INSERT INTO clickup_cards (id, custom_id, title, list, body, updated, json, seen_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     custom_id = excluded.custom_id, title = excluded.title, list = excluded.list,
     /* A page read WITHOUT bodies must not erase the body a heavier read
        already found — that would make the index forget the one field it is
        kept for, quietly, on the next cheap sweep. */
     body = CASE WHEN excluded.body <> '' THEN excluded.body ELSE clickup_cards.body END,
     updated = excluded.updated, json = excluded.json, seen_at = excluded.seen_at`,
);

/** Everything the sweep just read. Called with each page, so a slow sweep is
 *  already useful to the next question before it has finished. */
export function remember(cards: readonly IndexedCard[]): void {
  if (!cards.length) return;
  epoch++;
  const now = Date.now();
  try {
    waitedFor("clickup index write", () => db.transaction(() => {
      for (const c of cards) {
        const { body, ...task } = c;
        upsert.run(
          String(c.id), c.customId ?? "", c.title ?? "", c.list ?? "",
          kept(body ?? ""), Number(c.updated) || 0, JSON.stringify(task), now,
        );
      }
    })());
  } catch { /* an index that cannot be written is a slow search, not a broken one */ }
}

const byText = db.query<{ json: string; body: string }, [string, string, string]>(
  `SELECT json, body FROM clickup_cards
    WHERE lower(title) LIKE ? OR lower(custom_id) LIKE ? OR lower(list) LIKE ?
    ORDER BY updated DESC LIMIT 200`,
);
/* The bodies alone, then the json of the few that really mention the card. The table holds about 30 KB a row
   (199 MB for 6.7k cards on one machine), and this used to read and JSON.parse the json of up to 200 candidates
   to keep a handful. */
const bodyCandidates = db.query<{ id: string; body: string }, [string]>(
  `SELECT id, body FROM clickup_cards WHERE body LIKE ? ORDER BY updated DESC LIMIT 200`,
);
const cardById = db.query<{ json: string; body: string }, [string]>(
  `SELECT json, body FROM clickup_cards WHERE id = ?`,
);

/* The answer per card number, until the index changes. A search types one number into this once per keystroke
   that settles, and each miss is a scan of every body in the table. Any write bumps the epoch. */
let epoch = 0;
const memo = new Map<string, { epoch: number; cards: IndexedCard[] }>();
export let bodyScans = 0;

const parse = (rows: { json: string; body: string }[]): IndexedCard[] => {
  const out: IndexedCard[] = [];
  for (const r of rows) {
    try {
      const t = JSON.parse(r.json) as ProviderTask;
      if (t?.id) out.push(r.body ? { ...t, body: r.body } : t);
    } catch { /* a row we cannot read is a row we skip */ }
  }
  return out;
};

/** Cards whose title, id or list carry every word of the query. The LIKE is a
 *  first cut in SQL; the caller's own matcher decides, so the index can never
 *  answer something the live search would not. */
export function named(text: string): IndexedCard[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const like = `%${words[0]}%`;
  return waitedFor("clickup index search", () => parse(byText.all(like, like, like)));
}

/** Cards whose body mentions that card id. The SQL narrows by the digits, and
 *  `mentionsCardId` — the same rule the live search uses — decides, so a body
 *  that merely contains those digits inside a longer number is not a hit. */
export function mentioning(digits: string): IndexedCard[] {
  const hit = memo.get(digits);
  if (hit && hit.epoch === epoch) return hit.cards;
  const cards = waitedFor("clickup index body scan", () => {
    bodyScans++;
    const ids = bodyCandidates.all(`%${digits}%`).filter((r) => mentionsCardId(r.body ?? "", digits)).map((r) => r.id);
    return parse(ids.map((id) => cardById.get(id)).filter((r): r is { json: string; body: string } => !!r));
  });
  if (memo.size >= 32) memo.delete(memo.keys().next().value!);
  memo.set(digits, { epoch, cards });
  return cards;
}

/** How much is in there, for the one line that says whether an instant answer
 *  was possible at all. */
export function indexed(): { cards: number; withBody: number } {
  try {
    const r = db.query<{ n: number; b: number }, []>(
      "SELECT COUNT(*) AS n, SUM(CASE WHEN body <> '' THEN 1 ELSE 0 END) AS b FROM clickup_cards",
    ).get();
    return { cards: r?.n ?? 0, withBody: r?.b ?? 0 };
  } catch { return { cards: 0, withBody: 0 }; }
}

/**
 * Drop cards not seen by a sweep in `days`.
 *
 * The index is a cache of what the workspace sweep read, not a record of its
 * own: a card nobody has opened or searched for in that long is worth less
 * than the row it costs. A card still on a board gets its `seen_at` touched
 * every time that board's sweep runs (`remember`, above), so the open ones
 * are never the ones this deletes — the cutoff does that work with no extra
 * bookkeeping. `days` <= 0 keeps everything.
 */
export function evictOld(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = Date.now() - days * 86_400_000;
  epoch++;
  try { return waitedFor("clickup index evict", () => db.run("DELETE FROM clickup_cards WHERE seen_at < ?", [cutoff]).changes); }
  catch { return 0; }
}

// Sizes first (length of a blob is read from the cell header, not the body), bodies one at a time.
const slimSizes = db.query<{ rowid: number; n: number }, [number, number]>(
  `SELECT rowid, length(CAST(body AS BLOB)) n FROM clickup_cards WHERE rowid > ? ORDER BY rowid LIMIT ?`,
);
const slimBody = db.query<{ body: string }, [number]>(`SELECT body FROM clickup_cards WHERE rowid = ?`);
/** Bytes of body one slim step may read: bodies run to 106 KB, so 100 rows was up to 10 MB, 1 s of cold read + regex on the only thread. */
export const SLIM_STEP_BYTES = 256 * 1024;
const slimWrite = db.query<never, [string, number]>(`UPDATE clickup_cards SET body = ? WHERE rowid = ?`);
let slimAt = 0;
let slimOver = false;

/**
 * Rows written before `kept` existed still hold whole bodies: cut one page of
 * them down. Returns how many rows it looked at; 0 means the table is done.
 *
 * A page at a time because the first pass reads every old body once (301 MB
 * on the measured file), and that must not be one long hold of the only
 * thread: 100 rows is about 3 MB. `slimAll` spaces the pages out. The pass
 * runs once per process and costs a walk of the table on later boots; there
 * is no "done" mark on disk, which is the ceiling of this version. The pages
 * the cut frees go back to the filesystem when the pass ends (shrinkFreePages,
 * in small steps of its own).
 */
export function slimOld(batch = 100): number {
  if (slimOver) return 0;
  try {
    return waitedFor("clickup index slim", () => {
      const rows = slimSizes.all(slimAt, batch);
      // The end of the pass: hand back what it freed now, not at the next hourly retention pass.
      if (!rows.length) { slimOver = true; shrinkFreePages(); return 0; }
      let bytes = 0, done = 0;
      db.transaction(() => {
        for (const r of rows) {
          // Always at least one row, so a body over the budget still moves the pass on.
          if (done > 0 && bytes + r.n > SLIM_STEP_BYTES) break;
          bytes += r.n; done++; slimAt = r.rowid;
          if (r.n <= 1) continue;
          const body = slimBody.get(r.rowid)?.body ?? "";
          const short = kept(body);
          if (short.length < body.length) slimWrite.run(short, r.rowid);
        }
      })();
      return done;
    });
  } catch { slimOver = true; return 0; }
}

/** The whole pass, a page every `gapMs`, off whatever called it. */
export function slimAll(gapMs = 250, startMs = 60_000): void {
  if (slimOver) return;
  const step = () => { if (slimOld()) (setTimeoutAs("clickup index slim step", step, gapMs) as { unref?: () => void }).unref?.(); };
  // Not in the first minute after boot: the file is cold then and the first requests are reading it too.
  (setTimeoutAs("clickup index slim step", step, startMs) as { unref?: () => void }).unref?.();
}

/** For the tests: the next `slimOld` starts from the first row again. */
export function __slimAgain(): void { slimAt = 0; slimOver = false; }

/** Drop it. Exported for the tests, and for a person who wants the next search
 *  to go and read the workspace again. */
export function forget(): void {
  epoch++;
  try { db.query("DELETE FROM clickup_cards").run(); } catch { /* nothing to drop */ }
  try { db.query("DELETE FROM clickup_card_notes").run(); } catch { /* nothing to drop */ }
}

/* ── what a notification said about a card ─────────────────────────────── */

const noteIn = db.query<never, [string, string, string, string, number]>(
  `INSERT INTO clickup_card_notes (id, card_id, label, text, at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(id) DO NOTHING`,
);
const notesFor = db.query<{ text: string; at: number }, [string, string, string, string]>(
  /* An empty side matches NOTHING. Asked as a plain `card_id = ? OR label = ?`,
     a call with no label matched every row whose label was empty — every note
     on the machine, filed under whatever card was open. */
  `SELECT text, at FROM clickup_card_notes
    WHERE (? <> '' AND card_id = ?) OR (? <> '' AND label = ?)
    ORDER BY at ASC LIMIT 60`,
);

/**
 * Keep a mirrored notification that names a card.
 *
 * ClickUp's API has no history — who assigned it, who moved it, who was added
 * as a follower are invisible to it — while their own desktop notification
 * says exactly that, with a name in it. This machine already mirrors those, so
 * the ones that can be attributed to a card are kept and shown on it.
 *
 * The id is the notification's, so the same one arriving twice (the mirror
 * replaying, a second window) is stored once.
 */
export function rememberNote(n: { id: string; cardId: string; label: string; text: string; at: number }): void {
  if (!n.id || (!n.cardId && !n.label) || !n.text.trim()) return;
  /* Cut to what a notification can actually hold. The route feeding this is
     open to any local page and takes a 32 MB body; a mirrored notification is
     a title and a line or two, so 4 KB of text and 512 of label lose nothing
     real and stop one POST from parking megabytes in a table the card view
     reads on every open. */
  const id = n.id.slice(0, 200);
  const cardId = n.cardId.slice(0, 64);
  const label = n.label.slice(0, 512);
  const text = n.text.trim().slice(0, 4096);
  try { noteIn.run(id, cardId, label, text, n.at || Date.now()); } catch { /* not worth a failure */ }
}

/** What was seen about this card, oldest first — the order the card's own
 *  activity is read in. */
export function notesAbout(cardId: string, label: string): { text: string; at: number }[] {
  try { return notesFor.all(cardId || "", cardId || "", label || "", label || ""); } catch { return []; }
}
