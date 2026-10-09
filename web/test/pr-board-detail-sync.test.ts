/*
 * The board card and the open detail show ONE datum.
 *
 * An edit made in the detail (the card's status in the sidebar, an assignee, a
 * label, a reviewer) left the board card drawing the value from before, for
 * minutes. Two causes, both pinned here:
 *   - the ClickUp chip: a write forgot the store's entry instead of keeping the
 *     write's own answer, and `withCard` leaves a row copy younger than five
 *     minutes alone, so the row's server copy won until it aged out;
 *   - the GitHub fields: a list read BEFORE the edit came back over the
 *     overlay and undid it until the next poll.
 * No network: the store is fed by hand and never asks.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import type { PrDetail, PrSummary } from "../../shared/types.ts";
import type { ProviderTask } from "../../shared/providers.ts";
import { putCard, withCard, forgetCards } from "../src/lib/prCardStore.ts";
import { holdEdits, overlayDetail, rowPatch, type EditLog } from "../src/lib/prRefresh.ts";
import { assigneesPatch, reviewersPatch, milestonePatch, draftPatch, titlePatch } from "../src/lib/prOptimistic.ts";

beforeEach(() => forgetCards());

const row = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 7, title: "ORBIT-1042 thing", author: "ana", state: "OPEN", isDraft: false,
  headRefName: "ORBIT-1042-thing", baseRefName: "main", url: "", updatedAt: "2026-01-01T00:00:00Z",
  reviewDecision: null, additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
  reviewers: [], checksLoaded: true,
  card: { id: "c1", customId: "ORBIT-1042", title: "thing", url: "", status: "in development", at: Date.now() - 60_000 },
  ...over,
} as PrSummary);

const task = (status: string): ProviderTask => ({ id: "c1", customId: "ORBIT-1042", title: "thing", url: "", status } as ProviderTask);

describe("the ClickUp chip", () => {
  it("shows the status the detail just wrote, over a row copy younger than five minutes", () => {
    putCard("ORBIT-1042", task("code review"));
    expect(withCard(row(), true).card?.status).toBe("code review");
  });

  it("does not let an older store entry hide a newer board reading", () => {
    putCard("ORBIT-1042", task("code review"));
    const newer = row({ card: { ...row().card!, status: "done", at: Date.now() + 5_000 } });
    expect(withCard(newer, true).card?.status).toBe("done");
  });
});

describe("a list read before the edit", () => {
  const detail = (over: Partial<PrDetail> = {}) => ({
    ...row(), reviewers: [], body: "", ...over,
  }) as unknown as PrDetail;

  it("does not undo an edit made after the server read it", () => {
    const edited = detail({ assignees: ["ana"], isDraft: true });
    const log: EditLog = new Map([[7, { at: 2_000, patch: rowPatch(edited) }]]);
    const out = holdEdits([row()], log, 1_000, 3_000);
    expect(out[0].assignees).toEqual(["ana"]);
    expect(out[0].isDraft).toBe(true);
  });

  it("believes a list read after the edit", () => {
    const log: EditLog = new Map([[7, { at: 2_000, patch: rowPatch(detail({ assignees: ["ana"] })) }]]);
    const rows = [row()];
    expect(holdEdits(rows, log, 2_500, 3_000)).toBe(rows);
  });

  it("lets go of an edit after the hold", () => {
    const log: EditLog = new Map([[7, { at: 0, patch: rowPatch(detail({ assignees: ["ana"] })) }]]);
    holdEdits([row()], log, -1, 10 * 60_000);
    expect(log.size).toBe(0);
  });
});

describe("every sidebar field reaches the row", () => {
  const d = { ...row(), body: "", reviewers: [], comments: [], reviews: [], threads: [] } as unknown as PrDetail;
  const seen = (next: PrDetail) => overlayDetail([row()], next)[0];

  it("assignees", () => expect(seen(assigneesPatch(7, ["ana"], [])(d)).assignees).toEqual(["ana"]));
  it("reviewers", () => expect(seen(reviewersPatch(7, ["bob"], [])(d)).reviewers).toEqual([{ login: "bob" }]));
  it("milestone", () => expect(seen(milestonePatch(7, "v2")(d)).milestone).toBe("v2"));
  it("draft", () => expect(seen(draftPatch(7, true)(d)).isDraft).toBe(true));
  it("title", () => expect(seen(titlePatch(7, "renamed")(d)).title).toBe("renamed"));
  it("ignores another pull request", () => expect(assigneesPatch(8, ["ana"], [])(d)).toBe(d));
});
