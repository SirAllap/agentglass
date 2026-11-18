/*
 * THE SELF-CHECK THE UI READS (delivery 22b): which agent tabs hold no browser
 * credential, and why.
 *
 * The launcher now hands every agent tab a credential of its own
 * (`agentWindowEnv`, browseraccess.ts), so in a healthy app this list is empty.
 * This exists for the case where it is not: a path that skipped the door, a
 * server that restarted and did not rebuild a pane, a credential that expired
 * or was revoked with its turn. The UI's yellow dot reads `agentTabHealth`; the
 * route that names the worker to fix reads `reissueAgentCredential`.
 *
 * What it can and cannot know: the environment of a running process cannot be
 * read back (and this app never reads a credential file), so the state comes
 * from what THIS process handed the tab. A tab opened before this server
 * started is `unknown` with that reason said, never guessed as fine.
 */
import * as AgentOps from "./agentops.ts";
import { seatTokenLive, workerHeldAcrossRestart, workerTokenOf } from "./auth.ts";
import { browserOffReason, type BrowserAskContext } from "../../shared/browserWorkers.ts";
import { browserWorkersNow, flowRolesOf, holdCredential, windowCredentialOf } from "./browseraccess.ts";
import { browserAskContextFor } from "./rolePrompt.ts";
import { projectRootOf } from "./git.ts";
import { workerRole } from "../../shared/workerRoles.ts";
import { db } from "./db.ts";

export interface AgentTabHealth {
  name: string;
  kind: string;
  paneId: string;
  /** The project whose chair this tab is, or "". */
  seatRoot: string;
  seat: boolean;
  role: string;
  /** `pending` is a credential held for the tab's next start: nothing was
   *  handed to the process running now. */
  state: "ok" | "off" | "unknown" | "pending";
  /** The exact reason it is not `ok`; empty when it is. */
  reason: string;
  at: number | null;
}

interface SeatRow { root: string; name: string; kind: string; powers: string; adopted_pane: string }
const seats = db.query<SeatRow, []>(
  `SELECT root, name, kind, powers, COALESCE(adopted_pane, '') AS adopted_pane FROM seat WHERE ended_at IS NULL`);

function seatForName(name: string): SeatRow | null {
  try { return seats.all().find((s) => s.name === name) ?? null; } catch { return null; /* before the table exists */ }
}

/** One row per live agent tab: a named agent this app knows, plus an adopted
 *  seat (a session the person put in the chair, which has no named_agent row). */
export async function agentTabHealth(): Promise<AgentTabHealth[]> {
  await AgentOps.reconcile().catch(() => []);
  const tabs: AgentTabHealth[] = [];
  const seen = new Set<string>();
  for (const a of AgentOps.openNamed()) {
    seen.add(a.name);
    tabs.push(stateOf({ name: a.name, kind: a.kind, paneId: a.paneId, role: a.role ?? "" }));
  }
  for (const s of seats.all()) {
    if (!s.adopted_pane || seen.has(s.name)) continue;
    if (!(await AgentOps.paneAlive(s.adopted_pane))) continue;
    tabs.push(stateOf({ name: s.name, kind: s.kind || "claude", paneId: s.adopted_pane, role: "" }));
  }
  return tabs;
}

function stateOf(t: { name: string; kind: string; paneId: string; role: string }): AgentTabHealth {
  const seat = seatForName(t.name);
  const base = { name: t.name, kind: t.kind, paneId: t.paneId, role: t.role, seatRoot: seat?.root ?? "", seat: !!seat };
  const rec = windowCredentialOf(t.name);
  if (!rec) {
    return { ...base, state: "unknown", at: null,
      reason: "this server did not open this tab after its last start, so it holds no credential for it; resume or re-issue the tab" };
  }
  if (rec.state === "off") return { ...base, state: "off", at: rec.at, reason: rec.reason ?? "browser access is off for this tab" };
  /* A re-issued credential is held for the tab's NEXT start. Nothing was given
     to the process running now, and this server cannot see whether what that
     one holds is still live — answering `ok` here was the green dot on a tab
     the re-issue had just cut off. */
  if (rec.state === "pending") {
    return { ...base, state: "pending", at: rec.at,
      reason: "a fresh credential is held for this tab's next start; restart or Resume the tab to pick it up" };
  }
  /* A credential this process no longer holds is not a credential: a seat's is
     dropped with the chair, a worker's with its turn. */
  const live = seat ? seatTokenLive(seat.root) : !!workerTokenOf(t.name) || workerHeldAcrossRestart(t.name);
  if (!live) {
    return { ...base, state: "unknown", at: rec.at,
      reason: seat
        ? "this server holds no credential for this chair: it was issued before the last restart or revoked when the chair was emptied; re-seat the project"
        : "the credential this tab was handed was revoked or expired with its turn; re-issue it and start the tab again" };
  }
  return { ...base, state: "ok", at: rec.at, reason: "" };
}

export type ReissueResult =
  | { ok: true; name: string; state: "issued" | "re-seat"; applies: "next-start" | "next-seating"; note: string }
  | { ok: false; error: string; reason?: string };

/**
 * Re-issue one tab's credential for its next start.
 *
 * It cannot reach a process that is already running — an environment is fixed
 * at exec, and this app does not write credentials anywhere a live CLI would
 * re-read. So the credential is minted here, held for the tab, and the next
 * start through the one door consumes it instead of minting a second; the
 * answer says exactly that, so the UI's one click is "re-issue, then restart
 * or Resume". Refused with the reason when the person turned the engine off,
 * because a credential there would contradict a setting.
 *
 * A SEAT is not held this way: seating revokes every credential of the project
 * before it mints, so the next seating issues its own through the same door.
 * The answer says to re-seat rather than pretending to have delivered one.
 */
export function reissueAgentCredential(name: string): ReissueResult {
  const tab = AgentOps.openNamed().find((a) => a.name === name);
  const adopted = tab ? null : seats.all().find((s) => s.name === name && s.adopted_pane);
  if (!tab && !adopted) return { ok: false, error: `no live agent tab is called "${name}"` };
  const seat = seatForName(name);
  const engine = tab?.kind ?? adopted!.kind ?? "claude";
  const role = seat ? "" : tab?.role ?? "";
  const root = tab?.seatRoot ?? (tab?.cwd ? projectRootOf(tab.cwd) ?? tab.cwd : "");
  const ctx: BrowserAskContext = seat ? { seat: true }
    : !role ? { cardTab: true }
    : workerRole(role) ? {}
    : browserAskContextFor(root, role);
  const set = browserWorkersNow();
  const why = browserOffReason(set, engine, role, ctx, flowRolesOf(root || undefined));
  if (why) return { ok: false, error: "browser access is off for that tab", reason: why };
  if (seat) {
    /* Nothing is held for a chair: seating revokes the project's credentials
       before it mints, so a re-issue here cannot deliver anything and must not
       wear the `issued` a worker's held credential wears. */
    return {
      ok: true, name, state: "re-seat", applies: "next-seating",
      note: "a running process keeps the environment it started with; this chair's next seating mints and hands it a credential through the same door. Re-seat the project to apply it",
    };
  }
  holdCredential(name, tab ? projectRootOf(tab.cwd) ?? tab.cwd : undefined);
  return {
    ok: true, name, state: "issued", applies: "next-start",
    note: "a running process keeps the environment it started with; this credential is held for the tab and its next start or Resume hands it over",
  };
}
