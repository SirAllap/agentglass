import { describe, expect, test } from "bun:test";
import { dockFit, dockReason, dockSlots, tabView, TAB_IDS, type TabFacts } from "../src/lib/prDetailView.ts";

const f = (over: Partial<TabFacts> = {}): TabFacts => ({
  conversation: 4, newAtoms: 0, commits: 3, files: 7, checksTotal: 9, checksFailing: 0, drafts: 0, reviewAsked: false, reviewDraft: false, openFindings: 0, ...over,
});

describe("tabView", () => {
  test("Overview carries nothing", () => expect(tabView("overview", f())).toEqual({}));
  test("Checks: the total, and a red pill with the failing count only when something fails", () => {
    expect(tabView("checks", f()).hot).toBeUndefined();
    expect(tabView("checks", f({ checksFailing: 2 }))).toEqual({ count: 9, hot: { text: "2", tone: "bad", title: "2 failing" } });
  });
  test("Conversation: news is an accent pill, never red", () => {
    const v = tabView("conversation", f({ newAtoms: 3 }));
    expect(v.count).toBe(4);
    expect(v.hot).toEqual({ text: "3 new", tone: "accent", title: "3 new since you last looked" });
  });
  test("Review: a written draft is kept visible from every tab, a request outranks it", () => {
    expect(tabView("review", f({ reviewDraft: true })).hot?.text).toBe("draft");
    expect(tabView("review", f({ reviewDraft: true, reviewAsked: true })).hot?.text).toBe("asked");
    expect(tabView("review", f({ drafts: 2 })).count).toBe(2);
    expect(tabView("review", f()).count).toBeUndefined();
  });
  test("Review: open local findings are the red count, ahead of asked and draft, and settled ones count for nothing", () => {
    expect(tabView("review", f({ openFindings: 2 })).hot).toEqual({ text: "2", tone: "bad", title: "2 open local findings" });
    expect(tabView("review", f({ openFindings: 1 })).hot?.title).toBe("1 open local finding");
    expect(tabView("review", f({ openFindings: 2, reviewAsked: true })).hot?.tone).toBe("bad");
    expect(tabView("review", f({ openFindings: 0, reviewAsked: true })).hot?.text).toBe("asked");
  });
  test("Commits and Files carry their counts, zero included", () => {
    expect(tabView("commits", f({ commits: 0 })).count).toBe(0);
    expect(tabView("files", f()).count).toBe(7);
  });
});

describe("dockReason", () => {
  const base = { state: "OPEN" as const, merging: false, canMerge: true, isBehind: false, base: "main", blockedWhy: "Checks are failing" };
  test("ready", () => expect(dockReason(base)).toEqual({ kind: "ok", text: "Ready to land" }));
  test("a refusal beats GitHub's own answer", () =>
    expect(dockReason({ ...base, refusal: "Not approved yet", canMerge: true })).toEqual({ kind: "blocked", text: "Not approved yet" }));
  test("GitHub cannot merge and nothing refused first: GitHub's words", () =>
    expect(dockReason({ ...base, canMerge: false })).toEqual({ kind: "blocked", text: "Checks are failing" }));
  test("behind is mergeable but says so", () =>
    expect(dockReason({ ...base, canMerge: false, isBehind: true }).text).toBe("Ready to land, but main has moved on"));
  test("merged and closed have nothing to land", () => {
    expect(dockReason({ ...base, state: "MERGED" })).toEqual({ kind: "closed", text: "Already merged" });
    expect(dockReason({ ...base, state: "CLOSED" }).kind).toBe("closed");
  });
  test("merging", () => expect(dockReason({ ...base, merging: true }).text).toBe("Merging…"));
});

describe("dockFit", () => {
  test("mid and wide keep everything inline", () => {
    expect(dockFit("mid")).toEqual({ reason: true, draftClose: "inline", termLabel: true });
    expect(dockFit("wide")).toEqual({ reason: true, draftClose: "inline", termLabel: true });
  });
});

describe("the strip is six tabs", () => {
  test("the mockup's order, Review last and never left out", () =>
    expect([...TAB_IDS]).toEqual(["overview", "conversation", "commits", "files", "checks", "review"]));
});

describe("dockFit keeps the reason when it is the answer", () => {
  test("narrow and ready: the sentence goes, the terminal label goes", () =>
    expect(dockFit("narrow", "ok")).toEqual({ reason: false, draftClose: "menu", termLabel: false }));
  test("narrow and blocked or closed: the sentence stays", () => {
    expect(dockFit("narrow", "blocked").reason).toBe(true);
    expect(dockFit("narrow", "closed").reason).toBe(true);
  });
  test("mid and wide draw the label", () => expect(dockFit("mid", "blocked").termLabel).toBe(true));
});

describe("dockSlots: three slots, dimmed in place", () => {
  const s = { state: "OPEN" as const, canUpdate: false, behind: 0, updateLabel: "Update branch · 3 behind", conflicted: false, canTerm: true };
  test("nothing to do: Up to date, Resolve off, terminal hands the pull request to the review agent", () => {
    expect(dockSlots(s)).toEqual({ update: { label: "Up to date", enabled: false }, resolve: { enabled: false }, term: { kind: "review", enabled: true } });
  });
  test("behind: the label says how far and the slot is live", () =>
    expect(dockSlots({ ...s, canUpdate: true, behind: 3 }).update).toEqual({ label: "Update branch · 3 behind", enabled: true }));
  test("behind but not allowed to push: the label stays honest, the slot is dim", () =>
    expect(dockSlots({ ...s, behind: 3 }).update).toEqual({ label: "Update branch · 3 behind", enabled: false }));
  test("conflict: Resolve is live and the terminal takes the conflict", () => {
    const x = dockSlots({ ...s, conflicted: true });
    expect(x.resolve.enabled).toBe(true);
    expect(x.term.kind).toBe("conflict");
  });
  test("merged and closed turn the branch moves off", () => {
    const x = dockSlots({ ...s, state: "MERGED", canUpdate: true, conflicted: true });
    expect(x.update.enabled).toBe(false);
    expect(x.resolve.enabled).toBe(false);
  });
});
