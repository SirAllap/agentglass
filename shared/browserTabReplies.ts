/*
 * THE SHAPES THE PANEL ANSWERS THE TAB VERBS WITH, in one place.
 *
 * These lived inline in `web/src/lib/browserBus.ts`, which is DOM code and
 * cannot be loaded by a server test. A relay test then typed the shape by hand
 * and wrote a guard against its own fixture: the panel sends `tabs` as a BARE
 * ARRAY, the fixture was `{tabs: [...]}`, and the filter never fired on the
 * real answer. Both sides build their value here, so a shape change in the
 * panel changes every test that reads it.
 */
export interface TabRow {
  id: string;
  title: string;
  url: string;
  active: boolean;
  profile?: string;
}

/** `tabs`: the whole list, unfiltered — the relay scopes it per credential. */
export function tabsReply(rows: TabRow[]): { ok: true; value: TabRow[] } {
  return { ok: true, value: rows };
}

/** `tab`: the same list, with the one it switched to marked active. */
export function selectedReply(rows: TabRow[], picked: TabRow | undefined): { ok: true; value: TabRow[] } {
  return { ok: true, value: picked ? rows.map((t) => ({ ...t, active: t.id === picked.id })) : rows };
}

/** `closetab`: the list as it stands after the close. */
export function closedReply(rows: TabRow[]): { ok: true; value: TabRow[] } {
  return { ok: true, value: rows };
}

/** `open`/`newtab`: the mint, with the list folded in beside it. */
export function openedReply(
  made: { id: string }, rows: TabRow[],
): { ok: true; value: { id: string; tabs: TabRow[] } } {
  return { ok: true, value: { ...made, tabs: rows } };
}
