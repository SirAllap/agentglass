import { describe, expect, test } from "bun:test";
import { cap99, cardView, FAR_BEHIND, kFormat, mergeReason, STALE_DAYS, STRIP_FACES, trackerSlot } from "../src/lib/prCardView.ts";
import { cardReviewers } from "../src/lib/cardReviewers.ts";
import type { Filed } from "../src/lib/prLanes.ts";
import type { LeftoverState } from "../src/lib/leftovers.ts";
import type { PrCheckRollup } from "../../shared/types.ts";

const roll = (o: Partial<PrCheckRollup> = {}): PrCheckRollup => ({
  total: 8, success: 8, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [], ...o,
});

// The shape of a pull request on acme/orbit: open, approved, green, mergeable.
const pr = (o: Record<string, unknown> = {}) => ({
  number: 1042, title: "Retry the relay handshake", author: "mara-k", state: "OPEN" as const, isDraft: false,
  headRefName: "ORBIT-1042-retry-handshake", baseRefName: "main", mergeable: "MERGEABLE" as const,
  reviewDecision: "APPROVED" as const, checks: roll(), humanReview: undefined, ...o,
});
const filed = (lane: Filed["lane"], reason = "x", test?: Filed["test"]): Filed => ({ lane, reason, test });
const people = (...p: [string, string][]) => cardReviewers({ kind: "none", people: p.map(([login, state]) => ({ login, state })) });
const view = (p: ReturnType<typeof pr>, f: Filed, o: Partial<Parameters<typeof cardView>[0]> = {}) =>
  cardView({ p, filed: f, reviewers: cardReviewers(undefined), tracker: "card", hasTaskProvider: true, ...o });

describe("the footer's primary action", () => {
  test("the review lane says Review", () => {
    const v = view(pr({ reviewDecision: "REVIEW_REQUIRED" }), filed("review"));
    expect(v.primary).toMatchObject({ id: "review", label: "Review", title: "Open the review tab", disabled: false });
  });
  test("ready to land says Merge", () => {
    expect(view(pr(), filed("land")).primary).toMatchObject({ id: "merge", label: "Merge", title: "Merge when ready" });
  });
  test("a red card without a conflict offers to rerun only the failed checks", () => {
    const p = pr({ checks: roll({ failure: 2, success: 6, verdict: "red" }) });
    expect(view(p, filed("blocked")).primary).toMatchObject({ id: "rerun", label: "Rerun failed", title: "Rerun only the failed checks" });
  });
  test("a conflict outranks red: it asks to resolve, since nothing re-run gets past it", () => {
    const p = pr({ mergeable: "CONFLICTING", checks: roll({ failure: 2, verdict: "red" }) });
    expect(view(p, filed("blocked")).primary.id).toBe("resolve");
  });
  test("waiting, in flight, draft and closed cards open", () => {
    expect(view(pr(), filed("others")).primary).toMatchObject({ id: "open", label: "Open", title: "Open beside the board" });
    expect(view(pr(), filed("flight")).primary.id).toBe("open");
    expect(view(pr({ isDraft: true }), filed("flight")).primary.id).toBe("open");
    expect(view(pr({ state: "CLOSED" }), filed("others")).primary.id).toBe("open");
  });
  test("a merged card cleans up what it left on this computer", () => {
    expect(view(pr({ state: "MERGED" }), filed("land"), { leftovers: "1.4 GB" }).primary).toMatchObject({ id: "clean", label: "Clean up local leftovers" });
    expect(view(pr({ state: "MERGED" }), filed("land")).primary.id).not.toBe("clean");
  });
  test("a busy card keeps the action in its slot but switches it off", () => {
    expect(view(pr(), filed("land"), { busy: true }).primary).toMatchObject({ id: "merge", disabled: true });
  });
  test("read-only: Merge keeps its slot with a lock and says why", () => {
    const v = view(pr(), filed("land"), { readOnly: true });
    expect(v.primary).toMatchObject({ id: "merge", disabled: true, lock: true, title: "Read-only: the token has no write access" });
    expect(v.reasons.merge).toBe("Read-only: no write access");
  });
});

describe("the secondary slot", () => {
  test("a draft offers Mark ready", () => {
    expect(view(pr({ isDraft: true }), filed("flight")).secondary).toMatchObject({ id: "draft", label: "Mark ready" });
  });
  test("behind says how far; neither behind nor conflicting is the quiet text", () => {
    expect(view(pr(), filed("land"), { behind: 4 }).secondary).toMatchObject({ id: "update", label: "Update · 4", title: "Merge main into ORBIT-1042-retry-handshake" });
    expect(view(pr(), filed("land"), { behind: 0 }).secondary).toMatchObject({ id: null, label: "Up to date", upToDate: true });
  });
  test("a conflict offers Open beside Resolve; a finished card has no slot", () => {
    expect(view(pr({ mergeable: "CONFLICTING" }), filed("blocked")).secondary).toMatchObject({ id: "open" });
    expect(view(pr({ state: "MERGED" }), filed("land")).secondary).toMatchObject({ id: null, label: "", upToDate: false });
  });
});

describe("the verdict strip: one sentence and one colour per state", () => {
  const strip = (p: ReturnType<typeof pr>, f: Filed, o = {}) => {
    const v = view(p, f, o);
    return { text: v.strip.text, tone: v.tone, icon: v.strip.icon };
  };
  test("the plain states", () => {
    expect(strip(pr(), filed("review"))).toEqual({ text: "mara-k wants your review", tone: "info", icon: "eye" });
    expect(strip(pr(), filed("land"))).toEqual({ text: "Approved · ready to land", tone: "ok", icon: "ok" });
    expect(strip(pr({ isDraft: true }), filed("flight"))).toEqual({ text: "Draft · not asked yet", tone: "mute", icon: "edit" });
    expect(strip(pr({ state: "MERGED" }), filed("land"))).toEqual({ text: "Merged", tone: "merged", icon: "merge" });
    expect(strip(pr({ state: "CLOSED" }), filed("others"))).toEqual({ text: "Closed · not merged", tone: "mute", icon: "x" });
  });
  test("a conflict says with what, and adds the failing checks when there are some", () => {
    expect(strip(pr({ mergeable: "CONFLICTING" }), filed("blocked"))).toMatchObject({ text: "Conflicts with main", tone: "bad", icon: "alert" });
    const both = pr({ mergeable: "CONFLICTING", checks: roll({ failure: 2, verdict: "red" }) });
    expect(strip(both, filed("blocked")).text).toBe("Conflicts with main · 2 checks failing");
  });
  test("failing checks are counted, and the first failing check is named", () => {
    const failing = [{ name: "scheduler / lock", workflow: "scheduler", state: "failure" as const, done: true, url: "" }];
    const p = pr({ checks: roll({ failure: 2, verdict: "red", failing }) });
    expect(strip(p, filed("blocked")).text).toBe("2 checks failing · scheduler / lock");
    expect(strip(pr({ checks: roll({ failure: 1, verdict: "red" }) }), filed("blocked")).text).toBe("1 check failing");
  });
  test("approved with the checks still running says so, not that nobody asked", () => {
    const hr = { kind: "approved", who: "theo-w" };
    const v = view(pr({ humanReview: hr, checks: roll({ total: 12, success: 8, pending: 4, allDone: false, verdict: null }) }), filed("flight"), { reviewers: cardReviewers(hr) });
    expect(v.strip).toMatchObject({ text: "Approved · waiting for checks", icon: "clock" });
    expect(v.tone).toBe("run");
  });
  test("approved and then pushed to: green while GitHub still counts the approval, amber once somebody is asked again", () => {
    const hr = { kind: "approved", who: "theo-w", stale: true };
    const counted = view(pr({ humanReview: hr }), filed("land"), { reviewers: cardReviewers(hr) });
    expect(counted.strip.text).toBe("Approved · new commits since");
    expect(counted.tone).toBe("ok");
    const dismissed = view(pr({ humanReview: hr, reviewDecision: "REVIEW_REQUIRED" }), filed("land"), { reviewers: cardReviewers(hr) });
    expect(dismissed.tone).toBe("run");
    expect(dismissed.review).toMatchObject({ word: "stale", tone: "run" });
    const again = { ...hr, askedAgain: true, people: [{ login: "theo-w", state: "again" }] };
    expect(view(pr({ humanReview: again }), filed("land"), { reviewers: cardReviewers(again) }).tone).toBe("run");
  });
  test("changes asked for and not answered: red, with who, never 'no review asked'", () => {
    const one = people(["theo-w", "changes"], ["kofi-o", "approved"]);
    expect(strip(pr(), filed("flight", "x"), { reviewers: one })).toMatchObject({ text: "theo-w asked for changes", tone: "bad", icon: "alert" });
    const two = people(["theo-w", "changes"], ["kofi-o", "changes"]);
    expect(strip(pr(), filed("flight", "x"), { reviewers: two }).text).toBe("2 reviewers asked for changes");
    const mine = cardReviewers({ kind: "changes", mine: true, people: [{ login: "theo-w", state: "changes" }] });
    expect(strip(pr({ humanReview: { mine: true } }), filed("flight", "x"), { reviewers: mine }).text).toBe("You asked for changes");
  });
  test("changes that were applied and asked about again are the reviewer's move, in amber", () => {
    const cleared = people(["theo-w", "again"]);
    expect(strip(pr(), filed("others"), { reviewers: cleared })).toMatchObject({ text: "Waiting on theo-w", tone: "run" });
  });
  test("a review of yours that a push sent back says so", () => {
    const hr = { kind: "none", mine: true, people: [{ login: "mara-k", state: "again" }] };
    const v = view(pr({ humanReview: hr }), filed("review"), { reviewers: cardReviewers(hr) });
    expect(v.strip.text).toBe("mara-k pushed since your review");
    expect(v.review.word).toBe("asked again");
  });
  test("waiting names one person, or counts several", () => {
    const one = people(["theo-w", "await"]);
    expect(view(pr(), filed("others"), { reviewers: one }).strip.text).toBe("Waiting on theo-w");
    const many = people(["theo-w", "await"], ["kofi-o", "await"], ["ines-b", "again"]);
    expect(view(pr(), filed("others"), { reviewers: many }).strip.text).toBe("Waiting on 3 reviewers");
  });
  test("a quiet card says for how long once it has been 30 days", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    const at = (days: number) => new Date(now - days * 864e5).toISOString();
    const stale = view(pr({ updatedAt: at(STALE_DAYS + 5) }), filed("others"), { now, reviewers: people(["theo-w", "await"]) });
    expect(stale.strip.text).toBe("No activity for 35 days");
    const fresh = view(pr({ updatedAt: at(STALE_DAYS - 1) }), filed("others"), { now, reviewers: people(["theo-w", "await"]) });
    expect(fresh.strip.text).toBe("Waiting on theo-w");
  });
  test("blocked without red or conflict keeps the sentence that filed it; nothing asked says so", () => {
    expect(strip(pr(), filed("blocked", "Changes requested by theo-w."))).toMatchObject({ text: "Changes requested by theo-w.", tone: "bad" });
    expect(strip(pr(), filed("others"))).toMatchObject({ text: "Open · nobody asked yet", tone: "mute" });
  });
  test("while the second pass is out the card claims nothing", () => {
    const v = view(pr({ checks: roll({ failure: 3, verdict: "red" }) }), filed("blocked"), { reading: true });
    expect(v.strip.text).toBe("Reading the review");
    expect(v.ring.kind).toBe("reading");
  });
  test("the aria label leads with the number, the title and the verdict", () => {
    expect(view(pr(), filed("land")).aria).toBe("#1042 Retry the relay handshake. Approved · ready to land");
  });
});

describe("the strip's threads, faces and the 99+ cap", () => {
  test("open threads are counted, capped at 99+, and absent on a finished card", () => {
    expect(view(pr({ openThreads: { open: 3, more: false } }), filed("land")).strip.threads).toMatchObject({ text: "3" });
    expect(view(pr({ openThreads: { open: 240, more: true } }), filed("land")).strip.threads?.text).toBe("99+");
    expect(view(pr({ openThreads: { open: 0 } }), filed("land")).strip.threads).toBeNull();
    expect(view(pr({ state: "MERGED", openThreads: { open: 3 } }), filed("land")).strip.threads).toBeNull();
    expect(cap99(99)).toBe("99");
    expect(cap99(100)).toBe("99+");
  });
  test("the strip draws two faces, then +N; the Review cell draws one face and +N once there are three", () => {
    const four = people(["a-one", "await"], ["b-two", "await"], ["c-three", "approved"], ["d-four", "comment"]);
    const v = view(pr(), filed("others"), { reviewers: four });
    expect(v.stripFaces.faces).toHaveLength(STRIP_FACES);
    expect(v.stripFaces.more).toBe(2);
    expect(v.review.faces).toHaveLength(1);
    expect(v.review.more).toBe(3);
    const two = view(pr(), filed("others"), { reviewers: people(["a-one", "await"], ["b-two", "approved"]) });
    expect(two.review.faces).toHaveLength(2);
    expect(two.review.more).toBe(0);
  });
  test("the Review cell reads the people: changes beat waiting beat approved", () => {
    const word = (...p: [string, string][]) => view(pr(), filed("others"), { reviewers: people(...p) }).review;
    expect(word(["a-one", "approved"], ["b-two", "changes"])).toMatchObject({ word: "changes", tone: "bad" });
    expect(word(["a-one", "approved"], ["b-two", "await"])).toMatchObject({ word: "1 waiting", tone: "run" });
    expect(word(["a-one", "approved"])).toMatchObject({ word: "approved", tone: "ok" });
    expect(word(["a-one", "comment"])).toMatchObject({ word: "commented", tone: "mute" });
    expect(word()).toMatchObject({ word: "nobody asked", tone: "mute" });
    expect(view(pr({ isDraft: true }), filed("flight")).review.word).toBe("nobody asked");
  });
});

describe("the ring", () => {
  test("green: passed over total", () => {
    expect(view(pr(), filed("land")).ring).toMatchObject({ kind: "checks", caption: "8/8", green: 8, red: 0, running: 0, sub: null });
  });
  test("red: how many failed", () => {
    expect(view(pr({ checks: roll({ failure: 3, success: 5 }) }), filed("blocked")).ring).toMatchObject({ caption: "3 failing", red: 3, green: 5 });
  });
  test("running: the suite has not stopped, and says how many are out", () => {
    expect(view(pr({ checks: roll({ failure: 0, success: 6, pending: 2 }) }), filed("land")).ring).toMatchObject({ caption: "6/8", sub: "2 running" });
    expect(view(pr({ checks: roll({ failure: 1, success: 4, pending: 3 }) }), filed("blocked")).ring.sub).toBeNull();
  });
  test("no checks is a state, not a green ring; a closed one says closed", () => {
    const none = roll({ total: 0, success: 0 });
    expect(view(pr({ checks: none }), filed("land")).ring).toMatchObject({ kind: "none", caption: "no checks" });
    expect(view(pr({ checks: none, state: "CLOSED" }), filed("others")).ring).toMatchObject({ kind: "none", caption: "closed" });
  });
  test("a skipped check fills its segment green", () => {
    expect(view(pr({ checks: roll({ total: 8, success: 6, skipped: 2 }) }), filed("land")).ring).toMatchObject({ green: 8, caption: "8/8" });
  });
});

describe("the Branch cell", () => {
  test("a conflict is red and wins over being behind", () => {
    const v = view(pr({ mergeable: "CONFLICTING" }), filed("blocked"), { behind: 3 });
    expect(v.branch).toMatchObject({ label: "Branch", word: "conflict", tone: "bad" });
    expect(v.conflict).toBe(true);
  });
  test("behind turns amber, and red from FAR_BEHIND on", () => {
    expect(view(pr(), filed("land"), { behind: 4 }).branch).toMatchObject({ word: "4 behind", tone: "run" });
    expect(view(pr(), filed("land"), { behind: FAR_BEHIND }).branch).toMatchObject({ word: `${FAR_BEHIND} behind`, tone: "bad" });
    expect(view(pr(), filed("land"), { behind: FAR_BEHIND - 1 }).branch.tone).toBe("run");
  });
  test("up to date is green; unknown while git is asked says checking", () => {
    expect(view(pr(), filed("land"), { behind: 0 }).branch).toMatchObject({ word: "up to date", tone: "ok" });
    expect(view(pr(), filed("land"), { asking: true }).branch).toMatchObject({ word: "checking", tone: "mute" });
  });
  test("GitHub UNKNOWN reads checking, not a conflict, and not beside a conflict already known", () => {
    expect(view(pr({ mergeable: "UNKNOWN" }), filed("land"), { checking: true })).toMatchObject({ checking: true, branch: { word: "checking" } });
    expect(view(pr({ mergeable: "CONFLICTING" }), filed("blocked"), { checking: true }).checking).toBe(false);
  });
  test("a merged card says into where; a closed one says not merged; neither has anything to update", () => {
    const m = view(pr({ state: "MERGED", mergeable: "CONFLICTING" }), filed("land"), { behind: 9 });
    expect(m.branch).toMatchObject({ label: "Merged", word: "into main", tone: "merged" });
    expect(m.conflict).toBe(false);
    expect(m.behind).toBeNull();
    expect(view(pr({ state: "CLOSED" }), filed("others")).branch).toMatchObject({ word: "not merged", tone: "mute" });
  });
});

describe("the Changes cell", () => {
  test("counts print as 4.2k above 999, and the title says the files", () => {
    expect(kFormat(999)).toBe("999");
    expect(kFormat(4210)).toBe("4.2k");
    const v = view(pr({ additions: 4210, deletions: 80, changedFiles: 31 }), filed("land"));
    expect(v.third).toMatchObject({ label: "Changes", word: "+4.2k −80", add: 4210, del: 80, addShare: 98 });
    expect(v.third.title).toBe("31 files changed: +4210 −80");
  });
  test("nothing changed has no share", () => {
    expect(view(pr(), filed("land")).third).toMatchObject({ word: "+0 −0", addShare: null });
  });
  test("a finished card keeps Changes in the third cell; what it left on this computer is its own line", () => {
    const some: LeftoverState = { kind: "some", items: 2, bytes: 1_400_000_000, groups: [{ group: "worktree", items: 2, bytes: 1_400_000_000 }] };
    const v = view(pr({ state: "MERGED" }), filed("land"), { leftoverState: some });
    expect(v.third.label).toBe("Changes");
    expect(v.leftover).toMatchObject({ tone: "some" });
  });
  test("Clean up is the primary of any finished card that has leftovers, merged or closed, and waits while one runs", () => {
    const some: LeftoverState = { kind: "some", items: 1, bytes: 0, groups: [{ group: "worktree", items: 1, bytes: 0 }] };
    for (const state of ["MERGED", "CLOSED"] as const) expect(view(pr({ state }), filed("land"), { leftoverState: some }).primary.id).toBe("clean");
    expect(view(pr({ state: "MERGED" }), filed("land"), { leftoverState: some, cleaning: true }).primary.disabled).toBe(true);
    expect(view(pr({ state: "CLOSED" }), filed("land"), { leftoverState: { kind: "none" } }).primary.id).toBe("open");
    expect(view(pr(), filed("land"), { leftoverState: some }).leftover).toBeNull();
  });

});

describe("the event line and what ends it", () => {
  test("the line says the strip's words; the paragraph that filed the card is the tooltip's", () => {
    expect(view(pr(), filed("land", "  Approved 2h ago  ")).event).toEqual({ text: "Approved · ready to land", empty: false });
    expect(view(pr(), filed("land", " ")).event.text).toBe("Approved · ready to land");
  });
  test("a failing test read for the card is the line; so is the day a quiet one stopped", () => {
    expect(view(pr(), filed("blocked", "r", { title: "scheduler / lock", more: 0 })).event.text).toBe("scheduler / lock");
    const now = Date.parse("2026-10-29T10:00:00Z");
    expect(view(pr({ updatedAt: "2026-09-24T10:00:00Z" }), filed("flight"), { now }).event.text).toBe("nothing pushed or commented since Sep 24");
    expect(view(pr({ updatedAt: "2026-10-20T10:00:00Z" }), filed("land"), { now }).event.text).toBe("Approved · ready to land");
  });
  test("notes: absent is no review, 0 is a review with nothing open, 99+ is capped, finished has none", () => {
    expect(view(pr(), filed("land")).tail.notes).toBeNull();
    expect(view(pr(), filed("land"), { notes: 0 }).tail.notes).toEqual({ text: "0", n: 0 });
    expect(view(pr(), filed("land"), { notes: 120 }).tail.notes).toEqual({ text: "99+", n: 120 });
    expect(view(pr({ state: "MERGED" }), filed("land"), { notes: 3 }).tail.notes).toBeNull();
  });
  test("the lock and the labels follow the notes", () => {
    const v = view(pr(), filed("land"), { readOnly: true, labels: ["bug", "relay", "p1"] });
    expect(v.tail.readOnly).toBe(true);
    expect(v.tail.labels).toEqual({ first: "bug", more: 2, all: ["bug", "relay", "p1"] });
    expect(view(pr(), filed("land"), { labels: [] }).tail.labels).toBeNull();
  });
});

describe("the tracker slot", () => {
  test("a card that is read, loading, or only an id keeps its block", () => {
    expect(trackerSlot("card", true)).toBe("card");
    expect(trackerSlot("loading", true)).toBe("loading");
    expect(trackerSlot("id", true)).toBe("id");
  });
  test("a tracker repository without a card for this one draws the hint", () => {
    expect(trackerSlot("hint", true)).toBe("no-card");
  });
  test("no tracker connected is said; a connected one this repository does not use draws nothing", () => {
    expect(trackerSlot("none", false)).toBe("no-tracker");
    expect(trackerSlot("none", true)).toBe("none");
  });
});

describe("why an action is off", () => {
  test("merge: the first thing in the way, in the order of what would stop you", () => {
    const p = pr();
    expect(mergeReason(p)).toBeNull();
    expect(mergeReason({ ...p, isDraft: true, mergeable: "CONFLICTING" })).toBe("Draft pull requests cannot merge");
    expect(mergeReason({ ...p, mergeable: "CONFLICTING", checks: roll({ failure: 1 }) })).toBe("There is a conflict with main");
    expect(mergeReason({ ...p, checks: roll({ failure: 1 }) })).toBe("Checks are failing");
    expect(mergeReason({ ...p, checks: roll({ pending: 2 }) })).toBe("Checks are still running");
    expect(mergeReason({ ...p, reviewDecision: "REVIEW_REQUIRED" })).toBe("Not approved yet");
    expect(mergeReason({ ...p, state: "MERGED" })).toBe("Already merged");
    expect(mergeReason({ ...p, state: "CLOSED" })).toBe("Closed");
  });
  test("update, resolve and rerun each say why they are off", () => {
    const calm = view(pr(), filed("land")).reasons;
    expect(calm).toEqual({ merge: null, update: "Already up to date with main", resolve: "No conflict with main", rerun: "No failed checks" });
    const conflict = view(pr({ mergeable: "CONFLICTING" }), filed("blocked"), { behind: 2 }).reasons;
    expect(conflict.update).toBe("Resolve the conflict first");
    expect(conflict.resolve).toBeNull();
    expect(view(pr(), filed("land"), { behind: 2 }).reasons.update).toBeNull();
    expect(view(pr({ checks: roll({ failure: 1 }) }), filed("blocked")).reasons.rerun).toBeNull();
    expect(view(pr({ state: "MERGED" }), filed("land")).reasons.update).toBe("This pull request is finished");
  });
});

describe("the rest of the card", () => {
  test("kind", () => {
    expect(view(pr(), filed("land")).kind).toBe("open");
    expect(view(pr({ isDraft: true }), filed("flight")).kind).toBe("draft");
    expect(view(pr({ state: "CLOSED" }), filed("others")).kind).toBe("finished");
    expect(view(pr({ state: "MERGED" }), filed("land")).kind).toBe("finished");
  });
});
