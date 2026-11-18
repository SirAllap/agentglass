/*
 * The flow's Session start step: a worker's first turn opened for a Jira card
 * while the card sat in whatever status it was in before anyone picked it up
 * (ORBIT-1042 stayed in Backlog while its builder worked). A project may turn on
 * a move to a status of its own choosing, through the move door
 * (`jira.writes.move`) like every other move.
 *
 * Fire-and-forget: a worker's start never waits on this, and a Jira problem
 * here is reported, never thrown back at the start that is already answered.
 */
import type { CardRef } from "../cardbrief.ts";
import { getSetting } from "../preflightStore.ts";
import { epoch, isObj, moveIssue, movesOf, readBefore, storedCreds, str, writeRefusal } from "../jira.ts";
import { recordAction } from "../db.ts";
import { addReport } from "../seatreport.ts";

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Settings ▸ Jira ▸ Session start move, for this project. Empty status is "not set up". */
export function sessionStartMoveSetting(root: string): { on: boolean; status: string } {
  return { on: getSetting(root, "flow.sessionStart.move") === true, status: String(getSetting(root, "flow.sessionStart.moveStatus") ?? "").trim() };
}

/**
 * Move the card to the project's configured status, once, for a worker whose
 * first turn just started. Does nothing when the setting is off, the card is
 * not a Jira one, or no status is configured; reports why when the move
 * itself was refused or failed, naming the switch the move door's own
 * refusal names.
 */
export async function moveCardOnSessionStart(root: string, agent: string, ref: CardRef | null | undefined): Promise<void> {
  if (!ref || ref.tracker !== "jira") return;
  const { on, status } = sessionStartMoveSetting(root);
  if (!on || !status) return;
  const creds = storedCreds();
  if (!creds) return;
  const key = ref.id.toUpperCase();
  try {
    const off = writeRefusal("move");
    if (off) {
      addReport({ root, agent, text: `${key} stayed where it was: ${off}` });
      recordAction({ actor: "policy", action: "jira/session-start-move", target: key, ok: false, detail: off });
      return;
    }
    const before = await readBefore(creds, key, "updated,status");
    if ("stop" in before) return;
    const updated = epoch(before.f.updated);
    if (!updated) return;
    const statusName = isObj(before.f.status) ? str(before.f.status.name) : "";
    if (sameName(statusName, status)) return; // already there

    const moves = await movesOf(creds, key);
    if (!moves.ok || !moves.data) return;
    const match = moves.data.options.find((m) => sameName(m.toStatus, status) && !(m.needs && m.needs.length));
    if (!match) {
      addReport({ root, agent, text: `${key} stayed in ${statusName || "its status"}: no free move to ${status} from here` });
      recordAction({ actor: "policy", action: "jira/session-start-move", target: key, ok: false, detail: `no free move to ${status}` });
      return;
    }
    const r = await moveIssue(creds, key, match.id, updated);
    if (!r.ok) {
      addReport({ root, agent, text: `${key} stayed in ${statusName || "its status"}: ${r.error ?? "Jira refused the move"}` });
      recordAction({ actor: "policy", action: "jira/session-start-move", target: key, ok: false, detail: r.error ?? "refused" });
      return;
    }
    recordAction({ actor: "policy", action: "jira/session-start-move", target: key, ok: true, detail: `moved to ${status}` });
  } catch (e) {
    recordAction({ actor: "policy", action: "jira/session-start-move", target: key, ok: false, detail: (e as Error).message });
  }
}
