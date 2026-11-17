/*
 * Move a Jira card to a named status, by hand: the one write
 * `flow.sessionStart.move` (sessionStartMove.ts) and cleanup's "move the
 * card" step both need, kept here so a new caller does not re-derive the
 * same free-move lookup.
 */
import { epoch, isObj, movesOf, moveIssue, readBefore, storedCreds, str, writeRefusal } from "../jira.ts";

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Move `key` to `status` if it is not there already. Reads the card once to
 * get its `updated` stamp and current status, then the free moves from
 * there, and takes the first one that lands on `status` with no required
 * field on its screen. No match, and no free move, and no connection are
 * each a reported failure, never a thrown one.
 */
export async function moveCardTo(key: string, status: string): Promise<{ ok: boolean; detail: string }> {
  const off = writeRefusal("move");
  if (off) return { ok: false, detail: off };
  const creds = storedCreds();
  if (!creds) return { ok: false, detail: "no Jira connection" };
  const K = key.toUpperCase();
  const before = await readBefore(creds, K, "updated,status");
  if ("stop" in before) return { ok: false, detail: "could not read the card" };
  const updated = epoch(before.f.updated);
  if (!updated) return { ok: false, detail: "could not read the card's updated stamp" };
  const statusName = isObj(before.f.status) ? str(before.f.status.name) : "";
  if (sameName(statusName, status)) return { ok: true, detail: `already in ${status}` };
  const moves = await movesOf(creds, K);
  if (!moves.ok || !moves.data) return { ok: false, detail: "could not read the card's moves" };
  const match = moves.data.options.find((m) => sameName(m.toStatus, status) && !(m.needs && m.needs.length));
  if (!match) return { ok: false, detail: `no free move to ${status} from ${statusName || "its status"}` };
  const r = await moveIssue(creds, K, match.id, updated);
  return r.ok ? { ok: true, detail: `moved to ${status}` } : { ok: false, detail: r.error ?? "Jira refused the move" };
}
