/*
 * What the Settings > Knowledge page reads and writes about the understudy: the
 * retention figures, the on/off switch and the halt, and the one frame the
 * server sends (`useUnderstudy`).
 *
 * The rule this is built on: THE CLIENT DERIVES NOTHING. The server sends
 * `mode`, `offered` and the sentences saying what is in the way; the page
 * renders them. A gate about autonomy has exactly one implementation, and the
 * one that ships in a cached bundle is not it.
 */
import { useSyncExternalStore } from "react";
import type { UnderstudyFrame } from "../../../../shared/types.ts";
import { SERVER, authHeaders } from "../../lib/api.ts";
import { getUnderstudy, subscribeUnderstudy } from "../../lib/understudyStore.ts";

/**
 * How long the understudy's own two stores are kept.
 *
 * MIRRORED from `UNDERSTUDY_SNAPSHOT_DAYS` and `UNDERSTUDY_STUB_DAYS` in
 * server/src/db.ts, which is where the sweep that enforces them lives. A number
 * copied into a second file is a number that drifts, so it does not get to
 * drift quietly: web/test/understudy-no-thresholds.test.ts reads db.ts and
 * fails if these two stop matching it.
 *
 * Copied at all because the browser cannot import a module that opens a SQLite
 * database. The right fix is to put both on `UnderstudyFrame`, next to the seal
 * counts they belong beside, at which point this constant goes away rather than
 * being kept in step by a test.
 */
export const RETENTION = {
  /** The sealed situations, which is the material it read. */
  snapshotDays: 30,
  /** The bare fact of a write. Decisions and refusals never expire: they are
   *  the score, and a score with holes in it is not a score. */
  stubDays: 90,
} as const;

/* ------------------------------------------------------------- the ladder */

/* -------------------------------------------------------------- the seals */

/* ----------------------------------------------------------- the two POSTs */

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(SERVER + path, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!r.ok || j.ok === false) return { ok: false, error: j.error || `the server answered ${r.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: "could not reach the server" };
  }
}

/** Stop it. No confirmation and no arguments: a stop that needs a well-formed
 *  request is a stop that can fail to arrive. */
export const haltUnderstudy = (): Promise<{ ok: boolean; error?: string }> => post("/understudy/halt", {});

/**
 * Switch it on or off — and the one path that also lifts a halt.
 *
 * `halted` and `enabled` are two different facts (see UnderstudyFrame): halting
 * leaves it enabled and stopped, and switching it back on is the explicit act
 * that lowers the fence. There is no timer, which is the point.
 *
 * Exported because Settings owns the master switch and this view owns the
 * resume, and both are the same request.
 */
export const setUnderstudyEnabled = (on: boolean): Promise<{ ok: boolean; error?: string }> =>
  post("/understudy/enable", { on });

/**
 * The scorecard, as a hook.
 *
 * The store's snapshot is identity-cached — it hands back the same object until
 * the scorecard actually changes — which is the whole reason useSyncExternalStore
 * can be pointed straight at it. Do not wrap this in a map or a sort: a fresh
 * array per render is a fresh identity per render, and React answers that by
 * painting nothing at all.
 */
export function useUnderstudy(): UnderstudyFrame | null {
  return useSyncExternalStore(subscribeUnderstudy, getUnderstudy, getUnderstudy);
}

/* ------------------------------------------------------------- the panels */

/* ------------------------------------------------------------ the strip */

/* ---------------------------------------------------------------- the view */
