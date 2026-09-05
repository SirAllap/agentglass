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
import { db } from "./db.ts";
import type { ProviderTask } from "../../shared/providers.ts";
import { mentionsCardId } from "../../shared/cardRef.ts";

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
  const now = Date.now();
  try {
    db.transaction(() => {
      for (const c of cards) {
        const { body, ...task } = c;
        upsert.run(
          String(c.id), c.customId ?? "", c.title ?? "", c.list ?? "",
          body ?? "", Number(c.updated) || 0, JSON.stringify(task), now,
        );
      }
    })();
  } catch { /* an index that cannot be written is a slow search, not a broken one */ }
}

const byText = db.query<{ json: string; body: string }, [string, string, string]>(
  `SELECT json, body FROM clickup_cards
    WHERE lower(title) LIKE ? OR lower(custom_id) LIKE ? OR lower(list) LIKE ?
    ORDER BY updated DESC LIMIT 200`,
);
const withBodies = db.query<{ json: string; body: string }, [string]>(
  `SELECT json, body FROM clickup_cards WHERE body LIKE ? ORDER BY updated DESC LIMIT 200`,
);

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
  return parse(byText.all(like, like, like));
}

/** Cards whose body mentions that card id. The SQL narrows by the digits, and
 *  `mentionsCardId` — the same rule the live search uses — decides, so a body
 *  that merely contains those digits inside a longer number is not a hit. */
export function mentioning(digits: string): IndexedCard[] {
  return parse(withBodies.all(`%${digits}%`)).filter((c) => mentionsCardId(c.body ?? "", digits));
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

/** Drop it. Exported for the tests, and for a person who wants the next search
 *  to go and read the workspace again. */
export function forget(): void {
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
