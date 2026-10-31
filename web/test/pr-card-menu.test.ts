import { describe, expect, test } from "bun:test";
import { applyOff, cardMenu, menuHead, trackerNameOf, walkIds, type CardMenu, type MenuItem, type TrackerMode } from "../src/lib/prCardMenu.ts";
import { cardView } from "../src/lib/prCardView.ts";
import { cardReviewers } from "../src/lib/cardReviewers.ts";
import type { Filed } from "../src/lib/prLanes.ts";
import type { PrCheckRollup } from "../../shared/types.ts";

const roll = (o: Partial<PrCheckRollup> = {}): PrCheckRollup => ({
  total: 8, success: 8, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [], ...o,
});
const pr = (o: Record<string, unknown> = {}) => ({
  number: 1042, title: "Retry the relay handshake", author: "mara-k", state: "OPEN" as const, isDraft: false,
  headRefName: "ORBIT-1042-retry-handshake", baseRefName: "main", mergeable: "MERGEABLE" as const,
  reviewDecision: "APPROVED" as const, checks: roll(), humanReview: undefined, ...o,
});
const land: Filed = { lane: "land", reason: "x" };
const menu = (p = pr(), o: { mode?: TrackerMode; behind?: number | null; pinned?: boolean; stacked?: boolean; filed?: Filed; waiting?: boolean; readOnly?: boolean; leftovers?: string } = {}): CardMenu =>
  cardMenu({
    p, pinned: !!o.pinned, mode: o.mode ?? "clickup", tracker: "ClickUp", cardId: "ORBIT-1042", stacked: !!o.stacked,
    waiting: o.waiting, readOnly: o.readOnly, leftovers: o.leftovers,
    view: cardView({ p, filed: o.filed ?? land, reviewers: cardReviewers(undefined), behind: o.behind ?? null, readOnly: o.readOnly, tracker: "card", hasTaskProvider: true }),
  });
const items = (m: CardMenu): MenuItem[] => [...m.rows.filter((r): r is MenuItem => r.kind === "item"), ...m.more, m.close];
const get = (m: CardMenu, id: string) => items(m).find((x) => x.id === id)!;

describe("how many entries sit behind More", () => {
  test("counted from the list: 15 with a card on the tracker", () => {
    expect(menu().more).toHaveLength(15);
  });
  test("12 when there is no card to copy an id from", () => {
    expect(menu(pr(), { mode: "none" }).more).toHaveLength(12);
    expect(menu(pr(), { mode: "unlinked" }).more).toHaveLength(12);
  });
  test("a read-only card still has an id to copy", () => {
    expect(get(menu(pr(), { mode: "ro" }), "copycard")).toBeDefined();
  });
});

describe("the head line", () => {
  test("short titles are whole, long ones are cut at 30 with an ellipsis", () => {
    expect(menuHead({ number: 7, title: "Short" })).toBe("#7 · Short");
    const cut = menuHead({ number: 7, title: "x".repeat(60) });
    expect(cut).toBe(`#7 · ${"x".repeat(29)}…`);
  });
});

describe("hand over says what it will and will not do", () => {
  test.each([
    ["clickup", "Review, card assignee and status"],
    ["jira", "Review, card assignee and status"],
    ["none", "GitHub only: no tracker is connected"],
    ["unlinked", "GitHub only: no card is linked"],
    ["ro", "GitHub only: ClickUp is read-only"],
  ] as const)("%s", (mode, sub) => {
    const h = get(menu(pr(), { mode }), "hand");
    expect(h.sub).toBe(sub);
    expect(h.strong).toBe(true);
    expect(h.why).toBeUndefined();
  });
});

describe("the Card section", () => {
  test("a linked card opens in its tracker and the heading names the id", () => {
    const m = menu();
    expect(get(m, "card").label).toBe("Open ORBIT-1042 in ClickUp");
    expect(m.rows.find((r) => r.kind === "heading" && r.text.startsWith("Card"))).toEqual({ kind: "heading", text: "Card · ORBIT-1042" });
  });
  test("with no card the entry offers to link one; with no tracker it is off and says why", () => {
    expect(get(menu(pr(), { mode: "unlinked" }), "linkcard").why).toBeUndefined();
    const c = get(menu(pr(), { mode: "none" }), "connect");
    expect(c).toMatchObject({ label: "Connect a tracker in Settings", why: "No tracker is connected" });
  });
});

describe("the reasons an entry is off are the footer's reasons", () => {
  test("a green approved card can merge and has nothing to update, resolve or rerun", () => {
    const m = menu();
    expect(get(m, "merge").why).toBeUndefined();
    expect(get(m, "update").why).toBe("Already up to date with main");
    expect(get(m, "resolve").why).toBe("No conflict with main");
    expect(get(m, "rerun").why).toBe("No failed checks");
  });
  test("behind main turns Update on", () => {
    expect(get(menu(pr(), { behind: 3 }), "update").why).toBeUndefined();
  });
  test("a conflict turns Resolve on and Update off", () => {
    const m = menu(pr({ mergeable: "CONFLICTING" }), { filed: { lane: "blocked", reason: "x" } });
    expect(get(m, "resolve").why).toBeUndefined();
    expect(get(m, "update").why).toBe("Resolve the conflict first");
    expect(get(m, "merge").why).toBe("There is a conflict with main");
  });
  test("Squash and Rebase are off for the same reason as Merge", () => {
    const m = menu(pr({ isDraft: true }));
    for (const id of ["merge", "squash", "rebase"]) expect(get(m, id).why).toBe("Draft pull requests cannot merge");
  });
  test("a stacked pull request cannot change its base", () => {
    expect(get(menu(pr(), { stacked: true }), "base").why).toBe("In a stack: changing the base breaks it");
    expect(get(menu(), "base").why).toBeUndefined();
  });
});

describe("a finished pull request", () => {
  const off = ["hand", "reviewers", "nudge", "title", "labels", "update", "resolve", "rerun", "draft", "unstick", "base", "close"] as const;
  const stays = ["agent", "github", "copylink", "pin", "open", "full", "copynum", "copybranch", "term", "hideauthor", "hidebranch"] as const;
  test("merged keeps copy and open entries and turns off everything that would change it", () => {
    const m = menu(pr({ state: "MERGED" }));
    for (const id of off.filter((x) => x !== "close")) expect(get(m, id).why).toBe("Already merged");
    expect(get(m, "close").why).toBe("Already merged");
    expect(get(m, "merge").why).toBe("Already merged");
    expect(get(m, "watch").why).toBe("Nothing left to watch");
    for (const id of stays) expect(get(m, id).why).toBeUndefined();
  });
  test("merged leads with the clean-up, which is the one thing left to do", () => {
    const m = menu(pr({ state: "MERGED" }), { leftovers: "1.4 GB" });
    const first = m.rows[0] as MenuItem;
    expect(first).toMatchObject({ id: "clean", label: "Clean up local leftovers", strong: true, sub: "1.4 GB on this computer: worktree, branch, containers" });
    expect(walkIds(m, false)[0]).toBe("clean");
    expect(menu().rows.some((r) => r.kind === "item" && r.id === "clean")).toBe(false);
  });
  test("closed says to reopen first, and has no Close entry at all", () => {
    const m = menu(pr({ state: "CLOSED" }));
    for (const id of off.filter((x) => x !== "close")) expect(get(m, id).why).toBe("Closed: reopen it first");
    expect(m.closeAbsent).toBe(true);
    expect(walkIds(m, true)).not.toContain("close");
    expect(menu().closeAbsent).toBe(false);
  });
});

describe("the entries the page added", () => {
  test("Nudge reviewers is on only while somebody is asked and has not answered", () => {
    expect(get(menu(pr(), { waiting: true }), "nudge").why).toBeUndefined();
    expect(get(menu(), "nudge").why).toBe("Nobody is waiting");
  });
  test("Edit title and Edit labels sit under their own heading and work on an open or draft card", () => {
    const m = menu(pr({ isDraft: true }));
    const i = m.rows.findIndex((r) => r.kind === "heading" && r.text === "Edit");
    expect(m.rows.slice(i + 1, i + 3).map((r) => (r as MenuItem).id)).toEqual(["title", "labels"]);
    expect(get(m, "title").why).toBeUndefined();
    expect(get(m, "labels").why).toBeUndefined();
  });
  test("Copy card name and Copy card link sit with Copy card ID, only when there is a card", () => {
    const ids = (m: CardMenu) => m.more.map((x) => x.id);
    expect(ids(menu())).toEqual(expect.arrayContaining(["copycard", "copycardname", "copycardlink"]));
    expect(ids(menu(pr(), { mode: "none" }))).not.toContain("copycardname");
  });
  test("read-only turns every write off with one sentence and keeps the reads", () => {
    const m = menu(pr(), { readOnly: true });
    for (const id of ["hand", "reviewers", "title", "labels", "update", "resolve", "rerun", "draft", "unstick", "base", "close"]) {
      expect(get(m, id).why).toBe("Read-only: no write access");
    }
    for (const id of ["merge", "squash", "rebase"]) expect(get(m, id).why).toBe("Read-only: no write access");
    for (const id of ["github", "copylink", "pin", "open", "copynum", "copybranch", "agent"]) expect(get(m, id).why).toBeUndefined();
  });
  test("a card with no tracker offers Connect, and linking a card is off on a finished one", () => {
    expect(menu(pr(), { mode: "unlinked" }).rows.some((r) => r.kind === "item" && r.id === "linkcard")).toBe(true);
    expect(get(menu(pr({ state: "MERGED" }), { mode: "unlinked" }), "linkcard").why).toBe("Already merged");
  });
});

describe("the matrix: every entry in every state, read from the same function the menu draws", () => {
  const states: [string, Record<string, unknown>, Parameters<typeof menu>[1]][] = [
    ["ready", {}, {}],
    ["draft", { isDraft: true }, {}],
    ["review", { reviewDecision: "REVIEW_REQUIRED" }, { filed: { lane: "review", reason: "x" } }],
    ["red", { checks: roll({ failure: 2, verdict: "red" }) }, { filed: { lane: "blocked", reason: "x" } }],
    ["running", { checks: roll({ pending: 2, allDone: false }) }, {}],
    ["conflict", { mergeable: "CONFLICTING" }, { filed: { lane: "blocked", reason: "x" } }],
    ["behind", {}, { behind: 5 }],
    ["merged", { state: "MERGED" }, {}],
    ["closed", { state: "CLOSED" }, {}],
    ["stacked", {}, { stacked: true }],
  ];
  const state = (id: string, p: Record<string, unknown>, o: Parameters<typeof menu>[1]) => {
    const m = menu(pr(p), o);
    return get(m, id)?.why;
  };
  const row = (id: string) => Object.fromEntries(states.map(([n, p, o]) => [n, state(id, p, o)]));
  test("Merge works only on a ready card and says the first thing in the way on the rest", () => {
    expect(row("merge")).toEqual({
      ready: undefined, draft: "Draft pull requests cannot merge", review: "Not approved yet", red: "Checks are failing",
      running: "Checks are still running", conflict: "There is a conflict with main", behind: undefined,
      merged: "Already merged", closed: "Closed", stacked: undefined,
    });
  });
  test("Update works when behind; Resolve only on a conflict; Rerun only on red", () => {
    expect(Object.entries(row("update")).filter(([, v]) => !v).map(([k]) => k)).toEqual(["behind"]);
    expect(Object.entries(row("resolve")).filter(([, v]) => !v).map(([k]) => k)).toEqual(["conflict"]);
    expect(Object.entries(row("rerun")).filter(([, v]) => !v).map(([k]) => k)).toEqual(["red"]);
  });
  test("Change base is off in a stack and on a finished card, and nowhere else", () => {
    expect(Object.entries(row("base")).filter(([, v]) => v).map(([k]) => k)).toEqual(["merged", "closed", "stacked"]);
  });
  test("Open on GitHub, Copy link and Pin work in every state", () => {
    for (const id of ["github", "copylink", "pin"]) expect(Object.values(row(id)).every((v) => v === undefined)).toBe(true);
  });
});

describe("labels that follow the card", () => {
  test("Pin flips to Unpin, Convert to draft flips to Mark ready", () => {
    expect(get(menu(pr(), { pinned: true }), "pin").label).toBe("Unpin");
    expect(get(menu(), "pin").label).toBe("Pin");
    expect(get(menu(pr({ isDraft: true })), "draft").label).toBe("Mark ready for review");
    expect(get(menu(), "draft").label).toBe("Convert to draft");
  });
  test("the hide entries name the author", () => {
    expect(get(menu(), "hideauthor").label).toBe("Hide everything by mara-k");
  });
});

describe("the walk", () => {
  test("skips the entries that are off and always reaches More and Close", () => {
    const ids = walkIds(menu(), false);
    expect(ids[0]).toBe("hand");
    expect(ids).not.toContain("update");
    expect(ids).toContain("more");
    expect(ids.at(-1)).toBe("close");
    expect(ids).not.toContain("open");
  });
  test("More open adds its enabled entries between More and Close", () => {
    const ids = walkIds(menu(), true);
    expect(ids.indexOf("open")).toBeGreaterThan(ids.indexOf("more"));
    expect(ids.indexOf("open")).toBeLessThan(ids.indexOf("close"));
    expect(walkIds(menu(pr(), { stacked: true }), true)).not.toContain("base");
  });
  test("the first stop is a real entry even when the card is closed", () => {
    expect(walkIds(menu(pr({ state: "CLOSED" })), false)[0]).toBe("agent");
  });
});

describe("which tracker a card id belongs to", () => {
  const both = { clickup: {}, jira: { prefixes: ["ORBIT", "RLY"] } };
  test("one connected tracker owns every id", () => {
    expect(trackerNameOf("ORBIT-1", { clickup: {} })).toBe("ClickUp");
    expect(trackerNameOf("CU-9", { jira: { prefixes: ["ORBIT"] } })).toBe("Jira");
  });
  test("with both, a Jira project key claims its ids and the rest are ClickUp's", () => {
    expect(trackerNameOf("ORBIT-1", both)).toBe("Jira");
    expect(trackerNameOf("rly-4", both)).toBe("Jira");
    expect(trackerNameOf("CU-9", both)).toBe("ClickUp");
  });
  test("none connected is null", () => {
    expect(trackerNameOf("ORBIT-1", {})).toBeNull();
    expect(trackerNameOf("ORBIT-1", null)).toBeNull();
  });
});

describe("entries the panel cannot do yet", () => {
  test("go off with their own sentence, and an entry already off keeps the truer reason", () => {
    const m = applyOff(menu(pr(), { stacked: true }), { base: "Open the pull request to change its base", linkcard: "later" });
    expect(get(m, "base").why).toBe("In a stack: changing the base breaks it");
    expect(get(applyOff(menu(), { base: "Open the pull request to change its base" }), "base").why).toBe("Open the pull request to change its base");
    expect(walkIds(applyOff(menu(), { base: "x" }), true)).not.toContain("base");
  });
  test("nothing to turn off leaves the menu as it was", () => {
    const m = menu();
    expect(applyOff(m, undefined)).toBe(m);
  });
});
