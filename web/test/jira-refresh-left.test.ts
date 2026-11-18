/*
 * Refresh on a search view ("Mine": the site's JQL answer alone) must drop a card that left the search, and a write from
 * the detail must redraw the tile at once. Measured: ORBIT-1042 was given to another person from its detail; Refresh said
 * "read just now" but the tile stayed, with the old avatar, because the search answer was never asked again.
 */
import { expect, test } from "bun:test";
import type { ProviderTask } from "../../shared/providers.ts";
import { foldSite, newerThanBoard, overAfterRead, siteAsk, withSiteCards } from "../src/components/jira/list/model.ts";

const card = (id: string, o: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id, customId: id, title: `Card ${id}`, status: "To do", statusKind: "open", assignees: [], tags: [], priority: null, updated: 100, ...o } as ProviderTask);
const Q = "assignee = currentUser() AND project = ORBIT";
const ana = ["Ana Example"];
const ben = ["Ben Example"];

/** A fake search: the site answers the card, then (once reassigned) does not. */
function fakeSearch() {
  let theirs = false;
  return { reassign: () => { theirs = true; }, ask: () => (theirs ? [card("ORBIT-7")] : [card("ORBIT-1042", { assignees: ana }), card("ORBIT-7")]) };
}

test("Refresh asks the search again past the kept copy, and the card that left leaves the board", () => {
  const jira = fakeSearch();
  let site = { q: Q, full: false, round: 0, tasks: jira.ask() };
  expect(siteAsk(site, Q, false, 0)).toEqual({ ask: false, fresh: false }); // same round: the kept answer stands
  jira.reassign();
  // Refresh bumps the round: the same text is asked again, and fresh (the server's 30 s copy is skipped).
  const a = siteAsk(site, Q, false, 1);
  expect(a).toEqual({ ask: true, fresh: true });
  site = { q: Q, full: false, round: 1, tasks: jira.ask() };
  const cards = withSiteCards([], foldSite(site.tasks, {}), true);
  expect(cards.map((t) => t.id)).toEqual(["ORBIT-7"]);
  expect(siteAsk(site, Q, false, 1).ask).toBe(false);
});

test("a new search text is asked as before, not fresh", () => {
  expect(siteAsk({ q: Q, full: false, round: 3, tasks: [] } as never, "project = ORBIT", false, 3)).toEqual({ ask: true, fresh: false });
  expect(siteAsk(null, Q, false, 0)).toEqual({ ask: true, fresh: false });
});

test("an assignee change from the detail redraws the search's tile at once", () => {
  const site = [card("ORBIT-1042", { assignees: ana })];
  const after = card("ORBIT-1042", { assignees: ben, updated: 200 });
  const drawn = withSiteCards([], foldSite(site, { "ORBIT-1042": after }), true);
  expect(drawn[0]!.assignees).toEqual(["Ben Example"]);
  // The write is newer than the board's copy, so the board reads again; a plain detail read of the same card does not.
  expect(newerThanBoard(after, site[0])).toBe(true);
  expect(newerThanBoard(card("ORBIT-1042", { assignees: ana }), site[0])).toBe(false);
  expect(newerThanBoard(after, undefined)).toBe(false);
  // A newer copy that moved neither the person nor the status (a title edit) is drawn by the fold alone: no board read.
  expect(newerThanBoard(card("ORBIT-1042", { assignees: ana, title: "Renamed", updated: 200 }), site[0])).toBe(false);
  expect(newerThanBoard(card("ORBIT-1042", { assignees: ana, status: "Done", updated: 200 }), site[0])).toBe(true);
});

test("a read that lags behind the write does not put the old assignee back", () => {
  const after = card("ORBIT-1042", { assignees: ben, updated: 200 });
  const lagging = [card("ORBIT-1042", { assignees: ana, updated: 100 })];
  expect(overAfterRead({ "ORBIT-1042": after }, lagging)["ORBIT-1042"]).toBe(after);
  // Once the read carries the write (or newer), the read wins again.
  expect(overAfterRead({ "ORBIT-1042": after }, [card("ORBIT-1042", { assignees: ben, updated: 200 })])).toEqual({});
});
