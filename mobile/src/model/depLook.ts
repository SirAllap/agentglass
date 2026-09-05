/*
 * What each dependency status is called on the phone, and how loud it is.
 *
 * Typed against the server's own `DepStatus` rather than a list written here,
 * because the list written here was one short. `/dependencies` answers
 * `unsupported` for a tool a platform does not use — Docker Desktop on Linux,
 * `apt` on a Mac — and the Troubleshooting screen indexed a three-entry table
 * with it: `LOOK[dep.status]` was `undefined`, `.word` on that threw, and the
 * screen somebody opens to find out why things are broken was itself the thing
 * that was broken. A `Record<DepStatus, …>` cannot be one short; `tsc` says so.
 *
 * The words are the desk's (web/src/components/SettingsModal.tsx): the two
 * surfaces describe one machine, and two vocabularies for one fact is how they
 * drift.
 */
import type { DepStatus } from "../../../shared/deps.ts";

/** Which ink the row takes. Resolved to a colour by the screen, which owns the
 *  palette; this file only knows how serious each status is. */
export type DepTone = "good" | "warn" | "bad" | "mute";

export const DEP_LOOK: Record<DepStatus, { word: string; tone: DepTone }> = {
  ok: { word: "installed", tone: "good" },
  attention: { word: "needs a look", tone: "warn" },
  missing: { word: "missing", tone: "bad" },
  // Not a problem, so not a warning colour: there is nothing to install and
  // nothing to do, and a row that looked broken would send somebody to the
  // computer to fix a tool their platform never uses.
  unsupported: { word: "not used here", tone: "mute" },
};

/**
 * Does this row belong in the "what is wrong" set — expanded from the start,
 * and counted against "everything is installed"?
 *
 * `unsupported` does not: it is neither installed nor absent, and counting it
 * would make the summary line say something is missing on every machine that
 * has a platform.
 */
export const depNeedsAttention = (status: DepStatus): boolean =>
  status === "attention" || status === "missing";
