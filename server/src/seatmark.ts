/*
 * THE SEAT'S MARK — the one line that says a session is the orchestrator.
 *
 * A leaf module on purpose, exactly like lanternmark.ts: the mark is read by
 * the seat itself, by the board that must leave it out, and by the restore
 * sweeper, and none of those should have to import the other two to learn one
 * string.
 *
 * The mark is the first line of the prompt the SERVER composes, so a session
 * cannot claim the role by asking for it: the only way to carry this line is
 * to have been seated through `seat.ts`.
 */
export const SEAT_PROMPT_MARK = "You are the orchestrator for this project";

/** What `session_role` holds for a seated orchestrator. */
export const SEAT_ROLE = "orchestrator";
