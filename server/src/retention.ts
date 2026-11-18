/*
 * How long history is kept.
 *
 * Raw events are pruned at this many days; 0 keeps everything. The environment
 * variable wins when it is set (a headless run is told by its launcher), then
 * what the person chose in Settings, then 8: a full week plus the day the
 * window is cut in, so the 7-day views are always answerable.
 *
 * `RETENTION_DAYS` is a live binding: the sweep and every reader see a change
 * the moment Settings makes it, and the next sweep is what deletes older history.
 * It is its own module so choosing it does not open the database.
 */
import {
  retentionDaysSetting, writeRetentionDays,
  ledgerStubDaysSetting, writeLedgerStubDays,
  clickupCardDaysSetting, writeClickupCardDays,
} from "./config.ts";

export const RETENTION_FROM_ENV = process.env.AGENTGLASS_RETENTION_DAYS !== undefined;
export let RETENTION_DAYS = Math.max(0, Number(process.env.AGENTGLASS_RETENTION_DAYS ?? retentionDaysSetting() ?? 8));

/** Change the retention for this run and keep it. */
export function setRetentionDays(days: number): { ok: boolean; error?: string } {
  if (RETENTION_FROM_ENV) return { ok: false, error: "AGENTGLASS_RETENTION_DAYS is set in the environment this server started from, and it wins: unset it to choose here" };
  if (!Number.isInteger(days) || days < 0 || days > 3650) return { ok: false, error: "retention is a whole number of days from 0 (keep everything) to 3650" };
  const w = writeRetentionDays(days);
  if (!w.ok) return { ok: false, error: w.error };
  RETENTION_DAYS = days;
  return { ok: true };
}

/**
 * How long the understudy ledger keeps a bare `stub` row.
 *
 * Deliberately its own setting rather than riding on RETENTION_DAYS: that one
 * bounds the raw events the person asked for and may be set to 0, while this
 * bounds a store the person did not ask for. Its own default (90) and its own
 * switch, so turning event pruning off does not also turn this off.
 */
export let UNDERSTUDY_STUB_DAYS = Math.max(0, Number(ledgerStubDaysSetting() ?? 90));

export function setLedgerStubDays(days: number): { ok: boolean; error?: string } {
  if (!Number.isInteger(days) || days < 0 || days > 3650) return { ok: false, error: "retention is a whole number of days from 0 (keep everything) to 3650" };
  const w = writeLedgerStubDays(days);
  if (!w.ok) return { ok: false, error: w.error };
  UNDERSTUDY_STUB_DAYS = days;
  return { ok: true };
}

/** How many days a ClickUp card stays in the local index after it was last
 *  seen by a sweep. Its own setting: the index is a cache, not history, and
 *  nothing says it should share a window with either of the two above. */
export let CLICKUP_CARD_DAYS = Math.max(0, Number(clickupCardDaysSetting() ?? 30));

export function setClickupCardDays(days: number): { ok: boolean; error?: string } {
  if (!Number.isInteger(days) || days < 0 || days > 3650) return { ok: false, error: "retention is a whole number of days from 0 (keep everything) to 3650" };
  const w = writeClickupCardDays(days);
  if (!w.ok) return { ok: false, error: w.error };
  CLICKUP_CARD_DAYS = days;
  return { ok: true };
}
