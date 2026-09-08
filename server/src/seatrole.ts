/*
 * WHICH SESSIONS ARE THE SEAT — kept apart from seat.ts so the board can ask
 * without importing the thing that opens seats.
 *
 * `lantern.ts` has to leave the orchestrator out of its own board, and
 * `seat.ts` reads that board to compose the seat's prompt. One module asking
 * the other would be a cycle, so the question "is this session the seat?"
 * lives here, next to the mark and above nothing but the database.
 *
 * Persisted in `session_role` for the same reason the Lantern's mark is: the
 * seat outlives the process that opened it, and an in-memory set forgets it
 * on the first restart.
 */
import { sessionRoles, setSessionRole, sessionsWhosePromptStarts } from "./db.ts";
import { SEAT_PROMPT_MARK, SEAT_ROLE } from "./seatmark.ts";

const seats = new Set<string>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  for (const [id, role] of sessionRoles()) if (role === SEAT_ROLE) seats.add(id);
  for (const id of sessionsWhosePromptStarts(SEAT_PROMPT_MARK)) noteSeatSession(id);
}

export function noteSeatSession(id: string): void {
  if (!id || seats.has(id)) return;
  seats.add(id);
  setSessionRole(id, SEAT_ROLE);
}

export const isSeatSession = (id: string | undefined): boolean => { load(); return !!id && seats.has(id); };

/**
 * What `/ingest` asks of every hook event: is this the seat?
 *
 * The prompt is the only claim accepted, and the server composed it — a
 * session cannot talk its way into the role by posting `role: "orchestrator"`,
 * which is the difference between a mark and a label.
 */
export function hookSaysSeat(body: { hook_event_type?: unknown; payload?: unknown }): boolean {
  if (body.hook_event_type !== "UserPromptSubmit") return false;
  const prompt = (body.payload as { prompt?: unknown } | undefined)?.prompt;
  return typeof prompt === "string" && prompt.trimStart().startsWith(SEAT_PROMPT_MARK);
}

export function __resetSeatSessions(): void { seats.clear(); loaded = false; }
