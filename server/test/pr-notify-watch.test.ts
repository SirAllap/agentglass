import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrCheck, PrTalk, PrWatchFire } from "../../shared/types.ts";

/*
 * "Tell me when this PR's CI does X": each rule type on a mocked read, the
 * claim that makes a one-shot fire exactly once, and the persistence that lets
 * it survive a restart. The GitHub read is a function handed in, so nothing
 * here can reach the network.
 */
const dir = mkdtempSync(join(tmpdir(), "agx-prw-"));
process.env.AGENTGLASS_DB = join(dir, "t.db");
process.env.AGENTGLASS_SCAN_DISABLED = "1";

let W: typeof import("../src/prNotifyWatch.ts");
let DB: typeof import("../src/db.ts");
const fired: PrWatchFire[] = [];

beforeAll(async () => {
  DB = await import("../src/db.ts");
  W = await import("../src/prNotifyWatch.ts");
  W.subscribeWatchFire((f) => fired.push(f));
});
beforeEach(() => {
  DB.db.run("DELETE FROM pr_watch"); DB.db.run("DELETE FROM pr_watch_preset"); DB.db.run("DELETE FROM pr_watch_seen");
  DB.db.run("DELETE FROM pr_watch_fire"); W.__resetSchedule();
  fired.length = 0;
});

const chk = (name: string, state: PrCheck["state"], workflow = ""): PrCheck =>
  ({ name, workflow, state, done: state !== "pending" });
const snap = (all: PrCheck[]) => {
  const allDone = all.length > 0 && all.every((c) => c.done);
  return { allDone, verdict: allDone ? (all.some((c) => c.state === "failure") ? "red" as const : "green" as const) : null, all };
};
const ctx = { repo: "acme/orbit", number: 7, root: "/x/orbit", title: "ORBIT-1042 add thing" };
const add = (rule: unknown, over: Partial<typeof ctx> = {}) => W.addWatch({ ...ctx, ...over, rule });
/** A read whose answer the test changes between ticks. */
const reader = (initial: ReturnType<typeof snap>) => {
  const box = { s: initial, calls: 0 };
  return { box, read: async () => { box.calls++; return box.s; } };
};

describe("rules, decided on a snapshot", () => {
  it("all CI passed waits for every check, and fires on green", () => {
    const r = { type: "ci-pass" } as const;
    expect(W.evalRule(r, snap([chk("a", "success"), chk("b", "pending")]))).toBeNull();
    expect(W.evalRule(r, snap([chk("a", "success"), chk("b", "skipped")]))?.ok).toBe(true);
    expect(W.evalRule(r, snap([]))).toBeNull(); // no checks yet is not green
    // the verdict alone is not enough: a suite still running has none, and the guard is allDone
    expect(W.evalRule(r, { allDone: false, verdict: "green", all: [chk("a", "pending")] })).toBeNull();
    expect(W.evalRule(r, snap([chk("a", "success"), chk("b", "failure")]))).toBeNull();
  });
  it("any CI failed fires at the first failure, without waiting for the rest", () => {
    const o = W.evalRule({ type: "ci-fail" }, snap([chk("a", "failure"), chk("b", "pending")]));
    expect(o?.ok).toBe(false);
    expect(o?.detail).toBe("a");
    expect(W.evalRule({ type: "ci-fail" }, snap([chk("a", "success")]))).toBeNull();
  });
  it("a check pattern matches a check that appears LATER and each matrix variant", () => {
    const r = { type: "check", match: "evals", on: "fail" } as const;
    expect(W.evalRule(r, snap([chk("build", "success")]))).toBeNull(); // not started
    const later = snap([chk("build", "success"), chk("evals (py3.12)", "success"), chk("evals (py3.13)", "failure")]);
    expect(W.evalRule(r, later)?.summary).toBe("evals failed");
    expect(W.evalRule(r, later)?.detail).toBe("evals (py3.13)");
    expect(W.evalRule(r, snap([chk("build", "failure")]))).toBeNull(); // another check's failure is not his concern
  });
  it("the pattern also finds a job inside a workflow of that name, ignoring case", () => {
    const r = { type: "check", match: "EVALS", on: "fail" } as const;
    expect(W.evalRule(r, snap([chk("run", "failure", "Evals")]))).not.toBeNull();
  });
  it("check pass waits for every matching variant; either fires on the first failure or the last pass", () => {
    const pass = { type: "check", match: "evals", on: "pass" } as const;
    const either = { type: "check", match: "evals", on: "either" } as const;
    const half = snap([chk("evals (a)", "success"), chk("evals (b)", "pending")]);
    expect(W.evalRule(pass, half)).toBeNull();
    expect(W.evalRule(either, half)).toBeNull();
    const done = snap([chk("evals (a)", "success"), chk("evals (b)", "success")]);
    expect(W.evalRule(pass, done)?.summary).toBe("evals passed");
    expect(W.evalRule(either, done)?.ok).toBe(true);
    const bad = snap([chk("evals (a)", "failure"), chk("evals (b)", "pending")]);
    expect(W.evalRule(either, bad)?.ok).toBe(false);
    expect(W.evalRule(pass, bad)).toBeNull(); // asked for pass only
  });
  it("coerceRule drops what it does not know", () => {
    expect(W.coerceRule({ type: "nonsense" })).toBeNull();
    expect(W.coerceRule({ type: "check", match: "  ", on: "fail" })).toBeNull();
    expect(W.coerceRule({ type: "check", match: "evals", on: "x" })).toBeNull();
    expect(W.coerceRule({ type: "comment", extra: 1 })).toEqual({ type: "comment" });
  });
});

describe("cancelled and skipped runs", () => {
  // A new push or a sync with main cancels the previous runs all the time; GitHub's own state for them is failure.
  const cancelled = (name: string): PrCheck => ({ name, workflow: "", state: "failure", done: true, cancelled: true });
  it("a cancelled run is not a failure: neither CI failed nor the check rule fires on it", () => {
    const s = snap([chk("build", "success"), cancelled("evals (py3.12)")]);
    expect(W.evalRule({ type: "ci-fail" }, s)).toBeNull();
    expect(W.evalRule({ type: "check", match: "evals", on: "fail" }, s)).toBeNull();
    expect(W.evalRule({ type: "check", match: "evals", on: "either" }, s)).toBeNull();
  });
  it("a real failure beside a cancelled run still fires, naming only the real one", () => {
    const o = W.evalRule({ type: "ci-fail" }, snap([cancelled("a"), chk("b", "failure")]));
    expect(o?.detail).toBe("b");
  });
  it("a cancelled run is not finished: all CI passed and check-pass keep waiting for the rerun", () => {
    const s = { allDone: true, verdict: "green" as const, all: [chk("build", "success"), cancelled("evals")] };
    expect(W.evalRule({ type: "ci-pass" }, s)).toBeNull();
    expect(W.evalRule({ type: "check", match: "evals", on: "pass" }, s)).toBeNull();
  });
  it("skipped and neutral count as passed: an all-skipped suite passes, and so does a skipped matching check", () => {
    expect(W.evalRule({ type: "ci-pass" }, snap([chk("a", "skipped"), chk("b", "neutral")]))?.ok).toBe(true);
    expect(W.evalRule({ type: "check", match: "evals", on: "pass" }, snap([chk("evals", "skipped")]))?.summary).toBe("evals passed");
  });
  it("the rollup marks a CANCELLED conclusion and only that", async () => {
    const P = await import("../src/prs.ts");
    const run = (conclusion: string) => P.rollupChecks([{ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion }]).all[0]!;
    expect(run("CANCELLED").cancelled).toBe(true);
    expect(run("CANCELLED").state).toBe("failure"); // the board keeps its own reading
    expect(run("TIMED_OUT").cancelled).toBeUndefined();
    expect(run("FAILURE").cancelled).toBeUndefined();
  });
});

describe("firing", () => {
  it("pending then green fires once, turns itself off, and never again", async () => {
    add({ type: "ci-pass" });
    const { box, read } = reader(snap([chk("a", "pending")]));
    expect(await W.checkWatches(read)).toBe(0);
    box.s = snap([chk("a", "success")]);
    expect(await W.checkWatches(read)).toBe(1);
    expect(await W.checkWatches(read)).toBe(0);
    expect(await W.checkWatches(read)).toBe(0);
    expect(fired.length).toBe(1);
    expect(fired[0]!.summary).toBe("CI passed");
    expect(fired[0]!.repo).toBe("acme/orbit");
    expect(fired[0]!.number).toBe(7);
    const w = W.listWatches().watches[0]!;
    expect(w.active).toBe(false);
    expect(w.lastText).toBe("CI passed");
  });
  it("pending then red fires once as a failure", async () => {
    add({ type: "ci-fail" });
    const { box, read } = reader(snap([chk("a", "pending")]));
    await W.checkWatches(read);
    box.s = snap([chk("a", "failure")]);
    await W.checkWatches(read); await W.checkWatches(read);
    expect(fired.map((f) => [f.summary, f.ok])).toEqual([["CI failed", false]]);
  });
  it("two racing passes cannot both claim the same rule", async () => {
    add({ type: "ci-pass" });
    const { read } = reader(snap([chk("a", "success")]));
    await Promise.all([W.checkWatches(read), W.checkWatches(read)]);
    expect(fired.length).toBe(1);
  });
  it("several rules on one PR cost ONE read per tick, and each fires on its own", async () => {
    add({ type: "ci-pass" }); add({ type: "ci-fail" }); add({ type: "check", match: "evals", on: "fail" });
    const { box, read } = reader(snap([chk("evals", "pending"), chk("b", "success")]));
    await W.checkWatches(read);
    expect(box.calls).toBe(1);
    box.s = snap([chk("evals", "failure"), chk("b", "success")]);
    await W.checkWatches(read);
    expect(fired.map((f) => f.summary).sort()).toEqual(["CI failed", "evals failed"]);
    expect(W.listWatches().watches.filter((w) => w.active).map((w) => w.rule.type)).toEqual(["ci-pass"]); // still waiting
  });
  it("with nothing waiting there is no read at all; a comment rule is heard, and read only to learn the PR is still open", async () => {
    const { box, read } = reader(snap([chk("a", "success")]));
    await W.checkWatches(read);
    expect(box.calls).toBe(0);
    add({ type: "comment" });
    await W.checkWatches(read);
    expect(box.calls).toBe(1);
    expect(fired.length).toBe(0); // never fires from a read: a comment is an event, not a state
  });
  it("a failed read keeps the rule waiting", async () => {
    add({ type: "ci-pass" });
    await W.checkWatches(async () => { throw new Error("rate limited"); });
    expect(await W.checkWatches(async () => null)).toBe(0);
    expect(W.listWatches().watches[0]!.active).toBe(true);
  });
  it("a CI rule that has waited a week is dropped, so a merged PR is not read for ever", async () => {
    add({ type: "ci-pass" });
    const { box, read } = reader(snap([chk("a", "pending")]));
    await W.checkWatches(read, Date.now() + W.CI_RULE_TTL_MS + 1000);
    expect(box.calls).toBe(0);
    expect(W.listWatches().watches[0]!.lastText).toBe("expired");
  });
});

describe("comments", () => {
  const remark = (over: Partial<PrTalk> = {}): PrTalk => ({ at: new Date(Date.now() + 60_000).toISOString(), who: "ana", kind: "comment", ...over } as PrTalk);
  const seen = (talk: PrTalk[], number = 7) => W.onTalkSeen("acme/orbit", number, "t", talk);
  it("fires for each new remark and stays on", () => {
    add({ type: "comment" });
    expect(seen([remark()])).toBe(1);
    expect(seen([remark({ who: "bo", kind: "review", state: "CHANGES_REQUESTED", at: new Date(Date.now() + 120_000).toISOString() })])).toBe(1);
    expect(fired.map((f) => f.detail)).toEqual(["ana commented", "bo requested changes"]);
    expect(W.listWatches().watches[0]!.active).toBe(true);
  });
  it("a remark already reported is not reported again", () => {
    add({ type: "comment" });
    const r = remark();
    expect(seen([r])).toBe(1);
    expect(seen([r])).toBe(0);
  });
  it("a remark made BEFORE the rule was added, or by me, says nothing", () => {
    add({ type: "comment" });
    expect(seen([remark({ at: "2020-01-01T00:00:00Z" })])).toBe(0);
    expect(seen([remark({ mine: true })])).toBe(0);
  });
  it("a remark made while the server was down is reported at the first sight, with no in-memory latch to seed", () => {
    // What was measured: the list poll's latch records its first sight of a PR and says nothing, so a comment
    // made during downtime was swallowed. The rule's own memory is in the database (`seen`), set when it was added.
    add({ type: "comment" });
    expect(seen([remark()])).toBe(1); // the very first call this process makes about the PR
    expect(fired.length).toBe(1);
  });
  it("says nothing on another PR, or with no comment rule", () => {
    add({ type: "ci-pass" });
    add({ type: "comment" }, { number: 8 });
    expect(seen([remark()])).toBe(0);
    expect(fired.length).toBe(0);
  });
  it("stops when the person turns it off", () => {
    const id = add({ type: "comment" }).watch!.id;
    W.removeWatch(id);
    expect(seen([remark()])).toBe(0);
  });
});

describe("the fire queue: a closed window still gets told", () => {
  it("a fire with nobody listening is kept, oldest first, and handed over once acknowledged away", async () => {
    add({ type: "ci-pass" }, { number: 31 }); add({ type: "ci-pass" }, { number: 32 });
    await W.checkWatches(async () => snap([chk("a", "success")])); // no listener needs to exist for the fire to be kept
    const q = W.pendingFires();
    expect(q.map((f) => f.number).sort()).toEqual([31, 32]);
    expect(q[0]!.seq).toBeLessThan(q[1]!.seq);
    expect(W.ackFire(q[0]!.seq).ok).toBe(true);
    expect(W.pendingFires().map((f) => f.seq)).toEqual([q[1]!.seq]);
    W.ackFire(q[0]!.seq); // a second ack is harmless
    W.ackFire(q[1]!.seq);
    expect(W.pendingFires()).toEqual([]);
  });
  it("the live frame carries the same seq the queue holds", async () => {
    add({ type: "ci-pass" });
    await W.checkWatches(async () => snap([chk("a", "success")]));
    expect(fired[0]!.seq).toBe(W.pendingFires()[0]!.seq);
  });
  it("a comment fire is queued too", () => {
    add({ type: "comment" });
    W.onTalkSeen("acme/orbit", 7, "t", [{ at: new Date(Date.now() + 60_000).toISOString(), who: "ana", kind: "comment" } as PrTalk]);
    expect(W.pendingFires().map((f) => f.summary)).toEqual(["New comment"]);
  });
  it("an unacknowledged fire expires after 24 hours", async () => {
    add({ type: "ci-pass" });
    await W.checkWatches(async () => snap([chk("a", "success")]));
    expect(W.pendingFires(Date.now() + W.FIRE_TTL_MS - 60_000).length).toBe(1);
    expect(W.pendingFires(Date.now() + W.FIRE_TTL_MS + 60_000).length).toBe(0);
  });
});

describe("a PR that is no longer open ends every watch on it", () => {
  const withState = (state: string, s = snap([chk("a", "success")])) => ({ ...s, state });
  it("merged: no fire even though everything is green, comment rule included", async () => {
    add({ type: "ci-pass" }); add({ type: "ci-fail" }); add({ type: "comment" });
    await W.checkWatches(async () => withState("MERGED"));
    expect(fired.length).toBe(0);
    const ws = W.listWatches().watches;
    expect(ws.every((w) => !w.active && w.lastText === "merged")).toBe(true);
  });
  it("closed says closed, and a reopen does not revive anything", async () => {
    add({ type: "ci-pass" }); add({ type: "comment" });
    await W.checkWatches(async () => withState("CLOSED", snap([chk("a", "pending")])));
    expect(W.listWatches().watches.map((w) => [w.active, w.lastText])).toEqual([[false, "closed"], [false, "closed"]]);
    await W.checkWatches(async () => withState("OPEN")); // reopened and green
    expect(fired.length).toBe(0);
    expect(W.listWatches().watches.every((w) => !w.active)).toBe(true);
  });
  it("a comment-only PR is still read (slowly), because that is how it learns it was merged", async () => {
    add({ type: "comment" });
    const { box, read } = reader(withState("MERGED"));
    await W.checkWatches(read);
    expect(box.calls).toBe(1);
  });
});

describe("the read budget", () => {
  const mk = () => reader(snap([chk("a", "pending")]));
  it("a PR is read once a minute, not on every tick", async () => {
    add({ type: "ci-pass" });
    const { box, read } = mk();
    const t = Date.now();
    await W.checkWatches(read, t, true);
    await W.checkWatches(read, t + 10_000, true);
    await W.checkWatches(read, t + 59_000, true);
    expect(box.calls).toBe(1);
    await W.checkWatches(read, t + 61_000, true);
    expect(box.calls).toBe(2);
  });
  it("a rule that has waited half an hour is read every three minutes, and a comment-only PR every ten", async () => {
    add({ type: "ci-pass" });
    const { box, read } = mk();
    const t = Date.now() + 31 * 60_000; // 31 min after the rule was added
    await W.checkWatches(read, t, true);
    await W.checkWatches(read, t + 61_000, true);
    expect(box.calls).toBe(1);
    await W.checkWatches(read, t + 181_000, true);
    expect(box.calls).toBe(2);
    DB.db.run("DELETE FROM pr_watch"); W.__resetSchedule();
    add({ type: "comment" });
    const c = mk();
    await W.checkWatches(c.read, Date.now(), true);
    await W.checkWatches(c.read, Date.now() + 5 * 60_000, true);
    expect(c.box.calls).toBe(1);
  });
  it("a failed read backs that PR off, doubling, so a rate-limited account is not asked every minute", async () => {
    add({ type: "ci-pass" });
    let calls = 0;
    const t = Date.now();
    const bad = async () => { calls++; return null; };
    await W.checkWatches(bad, t, true);
    await W.checkWatches(bad, t + 61_000, true); // first retry is at 2 min, not 1
    expect(calls).toBe(1);
    await W.checkWatches(bad, t + 121_000, true);
    expect(calls).toBe(2);
    await W.checkWatches(bad, t + 121_000 + 200_000, true); // next wait is 4 min
    expect(calls).toBe(2);
  });
  it("one tick reads at most 20 PRs, however many are watched", async () => {
    for (let n = 1; n <= 25; n++) add({ type: "ci-pass" }, { number: 100 + n });
    const { box, read } = mk();
    await W.checkWatches(read, Date.now(), true);
    expect(box.calls).toBe(20);
    await W.checkWatches(read, Date.now(), true);
    expect(box.calls).toBe(25); // the other five are next; the first twenty are not due yet
  });
});

describe("adding", () => {
  it("the same rule twice is one rule; pressing it again after it fired turns it back on", async () => {
    add({ type: "ci-pass" }); add({ type: "ci-pass" });
    expect(W.listWatches().watches.length).toBe(1);
    await W.checkWatches(reader(snap([chk("a", "success")])).read);
    expect(W.listWatches().watches[0]!.active).toBe(false);
    add({ type: "ci-pass" });
    expect(W.listWatches().watches[0]!.active).toBe(true);
  });
  it("check patterns differing only in case are the same rule", () => {
    add({ type: "check", match: "Evals", on: "fail" }); add({ type: "check", match: "evals", on: "fail" });
    expect(W.listWatches().watches.length).toBe(1);
  });
  it("refuses a bad PR number, and a twenty-first rule on one PR", () => {
    expect(add({ type: "ci-pass" }, { number: -3 }).ok).toBe(false);
    expect(add({ type: "ci-pass" }, { number: 1.5 }).ok).toBe(false);
    for (let i = 0; i < 20; i++) expect(add({ type: "check", match: `c${i}`, on: "fail" }).ok).toBe(true);
    expect(add({ type: "check", match: "one-too-many", on: "fail" }).ok).toBe(false);
  });
  it("a corrupted rule row is skipped, not fatal to the list or the tick", async () => {
    add({ type: "ci-pass" });
    DB.db.run("INSERT INTO pr_watch (id, repo, number, root, title, rule, active, created) VALUES ('bad', 'acme/orbit', 7, '/x', 't', '{not json', 1, 1)");
    expect(W.listWatches().watches.length).toBe(1);
    expect(await W.checkWatches(async () => snap([chk("a", "success")]))).toBe(1);
  });
  it("refuses a rule it does not know", () => {
    expect(add({ type: "nope" }).ok).toBe(false);
  });
});

describe("presets", () => {
  it("apply puts the saved rules on a PR in one call, and is idempotent", () => {
    W.setPreset("acme/orbit", [{ type: "ci-pass" }, { type: "check", match: "evals", on: "fail" }, { type: "bogus" }], false);
    expect(W.applyPreset({ ...ctx }).applied).toBe(2);
    W.applyPreset({ ...ctx });
    expect(W.listWatches().watches.length).toBe(2);
    expect(W.applyPreset({ ...ctx, repo: "acme/other" }).ok).toBe(false);
  });
  it("auto applies to a NEW PR of mine only: the first read seeds, later ones apply", () => {
    W.setPreset("acme/orbit", [{ type: "ci-pass" }], true);
    expect(W.sawMine("acme/orbit", "/x", [{ number: 1, title: "old" }, { number: 2, title: "old" }])).toBe(0); // seed
    expect(W.sawMine("acme/orbit", "/x", [{ number: 1, title: "old" }, { number: 3, title: "new" }])).toBe(1);
    expect(W.sawMine("acme/orbit", "/x", [{ number: 3, title: "new" }])).toBe(0); // once
    expect(W.listWatches().watches.map((w) => w.number)).toEqual([3]);
  });
  it("auto off applies nothing, however many new PRs", () => {
    W.setPreset("acme/orbit", [{ type: "ci-pass" }], false);
    W.sawMine("acme/orbit", "/x", [{ number: 1, title: "a" }]);
    W.sawMine("acme/orbit", "/x", [{ number: 2, title: "b" }]);
    expect(W.listWatches().watches.length).toBe(0);
  });
  it("a preset drops duplicate rules", () => {
    W.setPreset("acme/orbit", [{ type: "ci-pass" }, { type: "ci-pass" }, { type: "check", match: "Evals", on: "fail" }, { type: "check", match: "evals", on: "fail" }], false);
    expect(W.listWatches().presets[0]!.rules.length).toBe(2);
  });
  it("an empty rule list clears the preset", () => {
    W.setPreset("acme/orbit", [{ type: "ci-pass" }], true);
    W.setPreset("acme/orbit", [], true);
    expect(W.listWatches().presets.length).toBe(0);
  });
});

describe("restart", () => {
  it("a waiting rule fires from a fresh process, and a fired one does not fire again", async () => {
    add({ type: "ci-pass" }, { number: 21 });
    add({ type: "ci-pass" }, { number: 22 });
    await W.checkWatches(async (_r, n) => (n === 22 ? snap([chk("a", "success")]) : snap([chk("a", "pending")])));
    expect(fired.map((f) => f.number)).toEqual([22]);
    // A second process on the same database: everything it knows is the file. The path
    // is asked of db.ts, not assumed: the suite shares one process and the first file to
    // import db.ts decides which database everybody is on.
    const code = `
      const W = await import(${JSON.stringify(join(import.meta.dir, "../src/prNotifyWatch.ts"))});
      const got = [];
      W.subscribeWatchFire((f) => got.push(f.number));
      await W.checkWatches(async () => ({ allDone: true, verdict: "green", all: [{ name: "a", workflow: "", state: "success", done: true }] }));
      console.log(JSON.stringify({ got, queued: W.pendingFires().map((f) => f.number) }));`;
    const p = Bun.spawn(["bun", "-e", code], {
      env: { ...process.env, AGENTGLASS_DB: DB.dbPath(), AGENTGLASS_SCAN_DISABLED: "1", NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    expect(err).not.toContain("error");
    const res = JSON.parse(out.trim().split("\n").pop()!);
    expect(res.got).toEqual([21]);
    // the fire decided by THIS process (22) is still queued in the other one, plus the one it just made
    expect(res.queued).toEqual([22, 21]);
  });
});

describe("wiring in the server", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  it("routes, frames and hooks are all connected, and the CI read goes through prRollup", async () => {
    const ix = strip(await Bun.file(join(import.meta.dir, "../src/index.ts")).text());
    for (const p of ["/prs/notify-watch/add", "/prs/notify-watch/remove", "/prs/notify-watch/apply", "/prs/notify-watch/default"]) expect(ix).toContain(p);
    expect(ix).toContain('broadcast({ type: "prwatchfire", data: f })');
    expect(ix).toContain('broadcast({ type: "prwatch", data: listWatches() })');
    expect(ix).toContain("subscribeTalkSeen(watchOnTalkSeen)");
    expect(ix).toContain('"/prs/notify-watch/ack"');
    expect(ix).toContain('"/prs/notify-watch/pending"');
    // past 100 contexts `all` is one page: the reader must not conclude "all done" from it
    expect(ix).toContain("allDone: r.checks.allDone && complete");
    expect(ix).toMatch(/searchParams\.get\("after"\) && !url\.searchParams\.get\("q"\)\) noteMine\(root, filter, state, listed\)/);
    const prs = strip(await Bun.file(join(import.meta.dir, "../src/prs.ts")).text());
    expect(prs).toContain("contexts(first:100){totalCount");
    expect(prs).toContain("truncated: Number(ctxs?.totalCount ?? 0) > raw.length");
    expect(ix).toMatch(/startPrNotifyWatch\(async \(root, number\) => \{\s*const r = await prRollup\(root, number\);/);
    // the POSTs are behind the same caller check as every other write
    const route = ix.slice(ix.indexOf('pathname.startsWith("/prs/notify-watch/")'));
    expect(route.slice(0, 200)).toContain("trustedCaller(req, from)");
  });
});

describe("shareChecks", () => {
  const snap = (pending: number): any => ({ checks: { total: 2, success: 2 - pending, failure: 0, skipped: 0, pending, allDone: !pending, verdict: pending ? null : "green" }, allDone: !pending, verdict: pending ? null : "green", all: [] });
  it("a read is said once per change, and only when it holds the whole rollup", () => {
    const got: number[] = [];
    const { shareChecks, subscribeWatchChecks } = W;
    const off = subscribeWatchChecks((c: any) => got.push(c.checks.pending));
    shareChecks("acme/orbit", 9001, snap(1));
    shareChecks("acme/orbit", 9001, snap(1));
    shareChecks("acme/orbit", 9001, snap(0));
    shareChecks("acme/orbit", 9002, { allDone: false, verdict: null, all: [] });
    off();
    expect(got).toEqual([1, 0]);
  });
});
