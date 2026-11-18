/*
 * THE ONE PLACE A PROJECT SEAT GETS ITS WINDOW ENVIRONMENT.
 *
 * A seat is an agent this app opens for a project, and it needs three things
 * the environment alone can carry: its own credential (so its calls are not
 * the person's machine token), the mark that names the project it speaks for,
 * and the engine's lock. Every path that opens or reopens that window must hand
 * it the same three, or the seat comes back with a different reach than the one
 * it had a minute before.
 *
 * It did not, and one path was the whole failure: `tmuxrestore` replayed every
 * agent pane through the old guard — no credential and `AGENTGLASS_BROWSER_OFF`
 * set — so after a reinstall, a reboot or an out-of-memory kill every project
 * seat came back unable to drive the browser. The fix is not a second mint in
 * the restore: a second mint is the bug, one per path, and the next path added
 * forgets it again. So the seat's environment is built here, by the same
 * `agentWindowEnv` every other agent tab goes through, and nothing else mints.
 *
 * A pane is recognised as a seat by the pair the app itself wrote when it made
 * the window: the name on the seat's row and the project's root. Its window
 * name is asked through `engineWindowName` because tmux rewrites a dot to a
 * dash (tmuxpane.ts), so a project whose folder has a dot in it would never
 * match by the row's name alone.
 */
import { agentNamed, chairLock } from "./agentops.ts";
import { agentWindowEnv, type AgentWindowCredential } from "./browseraccess.ts";
import { revokeSeatTokens } from "./auth.ts";
import { openSeatRows, type SeatPower } from "./seatpanes.ts";
import { engineWindowName, samePlace } from "./tmuxpane.ts";

export interface SeatWindow extends AgentWindowCredential {
  /** The credential the window was handed, already in `env`. */
  token: string | null;
}

/**
 * The seat's window environment: its own minted credential, the project it
 * speaks for, the engine's lock, and Settings ▸ Browser's answer for that
 * engine. `name` is the tab's (`seatName`, or the window a photograph holds),
 * because the credential is minted for the tab.
 *
 * The project's credentials are revoked first. Nothing else revoked them but
 * `openSeat`, and this runs once per seat pane a restore rebuilds: two replays
 * left two live `st_` for one chair, and the off branch minted its own as
 * well. A pane this replaces is gone, so nothing live is cut by it.
 */
export function seatWindowEnv(p: { root: string; powers: SeatPower; kind: string; name: string }): SeatWindow {
  revokeSeatTokens(p.root);
  return agentWindowEnv({
    name: engineWindowName(p.name) ?? p.name,
    engine: p.kind,
    seat: { root: p.root, powers: p.powers },
    base: chairLock(p.kind),
  });
}

/** A pane as a photograph describes it: what the window was called, whether
 *  this app opened it, and where its process was. */
export interface RestoreWindow {
  name?: string;
  owner?: string;
}

export type PaneRole =
  | { kind: "seat"; root: string; powers: SeatPower; engine: string }
  | { kind: "agent" }
  | { kind: "person" };

/**
 * What a restored pane is, decided from what the photograph holds and nothing
 * that died with the server.
 *
 * A seat: its row is still open, the process sits in the project's root, and
 * the window carries the name the app gave the chair OR the owner it pinned —
 * a person renames a tab, and matching by window name alone made the renamed
 * chair come back as a worker. An agent this app opened: the window carries the
 * owner the launcher pinned to it (reaper.ts), or a named agent's row still
 * names it. Everything else is the person's own window, replayed as theirs —
 * that is the other half of the fix: the person's Claude tab used to come back
 * marked off, which is not theirs to lose.
 */
export function paneRoleFor(window: RestoreWindow, path: string): PaneRole {
  const name = (window.name ?? "").trim();
  for (const s of openSeatRows()) {
    const named = engineWindowName(s.name);
    if ((named === name || (window.owner && window.owner === named)) && samePlace(path, s.root)) {
      return { kind: "seat", root: s.root, powers: s.powers, engine: s.kind };
    }
  }
  if (window.owner) return { kind: "agent" };
  const row = name ? agentNamed(name) : null;
  if (row && row.endedAt === null && samePlace(path, row.cwd)) return { kind: "agent" };
  return { kind: "person" };
}
