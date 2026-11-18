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

/**
 * `open`/`newtab`: the tab it made, named at the top, with the list of ITS
 * container folded in beside it.
 *
 * It used to fold in the whole window's list and say nothing else about the
 * new tab but its id. The list is read before the panel's selection reaches
 * it, so `active` still marks the tab that was in front — and a reader looking
 * for "the page I just opened" found the person's own tab there: `open --as
 * vault-test --show <url>` answered with the person's repositories page while
 * the new tab sat on a sign-in form. It also handed an agent the title and url
 * of every tab in every other container. So the answer names the made tab's
 * url, title and container itself, and lists only tabs in that container.
 */
export function openedReply(
  made: { id: string }, rows: TabRow[],
): { ok: true; value: { id: string; url?: string; title?: string; profile?: string; tabs: TabRow[] } } {
  const mine = rows.find((r) => r.id === made.id);
  if (!mine) return { ok: true, value: { ...made, tabs: [] } };
  const box = mine.profile || "default";
  const tabs = rows.filter((r) => (r.profile || "default") === box);
  return { ok: true, value: { ...made, url: mine.url, title: mine.title, profile: mine.profile, tabs } };
}
