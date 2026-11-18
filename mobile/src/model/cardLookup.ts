/*
 * Finding the card behind a pull request row, without spending ClickUp.
 *
 * Two questions, priced differently. `where` reads the boards the computer has
 * already cached and costs ClickUp nothing; `find` asks ClickUp for one card
 * and costs a request on a token that is ~100 a minute and shared with the
 * person's real work. So `where` runs by itself for every row that needs it,
 * and `find` runs only when somebody taps, two at a time at most: a screen of
 * twenty misses must not become twenty simultaneous requests.
 *
 * Injected I/O, so the limits are held by a test rather than by a screen.
 */
import { CARD_FRESH_MS, cardLineOf, type CardLine, type Looked } from "./prCard.ts";
import type { ProviderTask } from "../../../shared/providers.ts";

export interface LookupIo {
  /** The cached boards' answer: a task, or null for "not that we know of". */
  where(id: string): Promise<ProviderTask | null>;
  /** The tracker's own answer for one id. */
  find(id: string): Promise<{ task?: ProviderTask | null; error?: string }>;
}

/** Whose card a table draws: the card a row shows opens that tracker's screen. */
type Tracker = "clickup" | "jira";

/** Enough to keep the list moving; `where` is local, so it is not the scarce one. */
const WHERE_AT_ONCE = 4;
/** The budget: see the header. */
const FIND_AT_ONCE = 2;

export function createCardLookups(io: LookupIo, tracker: Tracker = "clickup", freshMs = CARD_FRESH_MS) {
  const held = new Map<string, Looked>();
  /** When a reading was last asked of the tracker itself, per id. */
  const refreshedAt = new Map<string, number>();
  const whereQ: string[] = [];
  const findQ: string[] = [];
  const listeners = new Set<() => void>();
  let whereRunning = 0;
  let findRunning = 0;

  const set = (id: string, v: Looked): void => {
    held.set(id, v);
    for (const l of listeners) l();
  };

  function pumpWhere(): void {
    while (whereRunning < WHERE_AT_ONCE && whereQ.length) {
      const id = whereQ.shift()!;
      whereRunning++;
      io.where(id)
        .then((t) => set(id, t ? { phase: "card", card: cardLineOf(t, tracker) } : { phase: "missed" }))
        .catch(() => set(id, { phase: "missed" }))
        .finally(() => { whereRunning--; pumpWhere(); });
    }
  }

  function pumpFind(): void {
    while (findRunning < FIND_AT_ONCE && findQ.length) {
      const id = findQ.shift()!;
      findRunning++;
      io.find(id)
        .then((r) => set(id, r.task ? { phase: "card", card: cardLineOf(r.task, tracker) } : { phase: "failed" }))
        .catch(() => set(id, { phase: "failed" }))
        .finally(() => { findRunning--; pumpFind(); });
    }
  }

  return {
    peek: (id: string): Looked | null => held.get(id) ?? null,
    /** Start the free lookup, once per id. */
    where(id: string): void {
      if (!id || held.has(id)) return;
      set(id, { phase: "where" });
      whereQ.push(id);
      pumpWhere();
    },
    /** The one paid request. Ignored unless the free lookup has already missed
     *  (or a previous find failed, which is what tapping again is for). */
    find(id: string): void {
      const now = held.get(id);
      if (!now || (now.phase !== "missed" && now.phase !== "failed")) return;
      set(id, { phase: "finding" });
      findQ.push(id);
      pumpFind();
    },
    /**
     * Ask the tracker for a card the row already names, because what the row
     * carries is older than a few minutes — the server fills it from a board
     * cached on disk and accepts a day-old one, so a card moved this morning
     * drew its old status all day (the desktop re-asks at five minutes, see
     * prCardStore). Once per TTL: every render calls this.
     *
     * A failure leaves what is on screen alone rather than blanking it to "not
     * found": the old status is wrong-ish, an empty card is wrong.
     */
    refresh(id: string): void {
      if (!id) return;
      const now = Date.now();
      const asked = refreshedAt.get(id);
      if (asked !== undefined && now - asked < freshMs) return;
      refreshedAt.set(id, now);
      set(id, { phase: "finding" });
      findQ.push(id);
      pumpFind();
    },
    /** A reading is not forever: a refresh asks again. */
    clear(): void {
      held.clear();
      refreshedAt.clear();
      whereQ.length = 0;
      findQ.length = 0;
      for (const l of listeners) l();
    },
    subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

export type CardLookups = ReturnType<typeof createCardLookups>;
export type { CardLine };
