import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrCheck, PrWatchFire } from "../../shared/types.ts";

/*
 * "CI passed" after Update branch. The branch is merged on GitHub a moment after the button is pressed, and until
 * the new head has its own checks the read still returns the OLD head with its old green runs: a watch armed in
 * that gap announced a run that was about to be replaced. The watch now hears that a sync was accepted, and a CI
 * result counts only for a head other than the one the sync started from. The GitHub read is a function handed
 * in, so nothing here can reach the network.
 */
const dir = mkdtempSync(join(tmpdir(), "agx-prsync-"));
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
  DB.db.run("DELETE FROM pr_watch"); DB.db.run("DELETE FROM pr_watch_fire"); DB.db.run("DELETE FROM asked_alert");
  DB.db.run("DELETE FROM pr_sync_mark"); W.__resetSchedule();
  fired.length = 0;
});

const OLD = "aaaaaaa1111111111111111111111111111aaaaa";
const NEW = "bbbbbbb2222222222222222222222222222bbbbb";
const chk = (name: string, state: PrCheck["state"]): PrCheck => ({ name, workflow: "", state, done: state !== "pending" });
/** What the read returns for a head: its checks, or none at all when GitHub has not created them yet. */
const at = (sha: string, all: PrCheck[]) => {
  const allDone = all.length > 0 && all.every((c) => c.done);
  return { allDone, verdict: allDone ? "green" as const : null, all, sha, ...(all.length ? { checks: { total: all.length } as never } : null) };
};
const ctx = { repo: "acme/orbit", number: 7, root: "/x/orbit", title: "ORBIT-1042 add thing" };
const add = (rule: unknown, over: Partial<typeof ctx> = {}) => W.addWatch({ ...ctx, ...over, rule });
const reader = (initial: ReturnType<typeof at>) => {
  const box = { s: initial, calls: 0 };
  return { box, read: async () => { box.calls++; return box.s; } };
};
const watchOf = (n = 7) => W.listWatches().watches.find((w) => w.number === n)!;

describe("a sync was accepted: the old head's result is not news", () => {
  it("sync, then arm: the old run, still green, does not fire", async () => {
    W.noteSync("acme/orbit", 7, OLD);
    add({ type: "ci-pass" });
    const { read } = reader(at(OLD, [chk("a", "success")]));
    expect(await W.checkWatches(read)).toBe(0);
    expect(await W.checkWatches(read)).toBe(0);
    expect(fired.length).toBe(0);
    expect(watchOf().active).toBe(true);
  });
  it("arm, then sync: the same", async () => {
    add({ type: "ci-pass" });
    const { box, read } = reader(at(OLD, [chk("a", "pending")]));
    await W.checkWatches(read);
    W.noteSync("acme/orbit", 7, OLD);
    box.s = at(OLD, [chk("a", "success")]);
    expect(await W.checkWatches(read)).toBe(0);
  });
  it("the old head's failure does not fire either", async () => {
    W.noteSync("acme/orbit", 7, OLD);
    add({ type: "ci-fail" });
    expect(await W.checkWatches(reader(at(OLD, [chk("a", "failure")])).read)).toBe(0);
  });
  it("a new head with no checks yet is not started, never passed", async () => {
    W.noteSync("acme/orbit", 7, OLD);
    add({ type: "ci-pass" });
    const { box, read } = reader(at(NEW, []));
    expect(await W.checkWatches(read)).toBe(0);
    expect(watchOf().sync?.state).toBe("moved");
    box.s = at(NEW, [chk("a", "pending"), chk("b", "pending")]);
    expect(await W.checkWatches(read)).toBe(0);
  });
  it("a new head whose checks are queued or half done does not fire; all green fires once, for the new head", async () => {
    W.noteSync("acme/orbit", 7, OLD);
    add({ type: "ci-pass" });
    const { box, read } = reader(at(OLD, [chk("a", "success")]));
    await W.checkWatches(read);
    box.s = at(NEW, [chk("a", "success"), chk("b", "pending")]);
    expect(await W.checkWatches(read)).toBe(0);
    box.s = at(NEW, [chk("a", "success"), chk("b", "success")]);
    expect(await W.checkWatches(read)).toBe(1);
    expect(await W.checkWatches(read)).toBe(0);
    expect(fired.length).toBe(1);
    expect(fired[0]!.summary).toBe("CI passed on bbbbbbb");
    expect(DB.db.query("SELECT COUNT(*) AS n FROM pr_sync_mark").get()).toEqual({ n: 0 });
  });
  it("a sync that could not read its starting head learns it from the first read", async () => {
    W.noteSync("acme/orbit", 7, null);
    add({ type: "ci-pass" });
    const { box, read } = reader(at(OLD, [chk("a", "success")]));
    expect(await W.checkWatches(read)).toBe(0);
    box.s = at(NEW, [chk("a", "success")]);
    expect(await W.checkWatches(read)).toBe(1);
  });
  it("two pull requests never mix: a sync on one holds nothing on the other, same head or not", async () => {
    W.noteSync("acme/orbit", 7, OLD);
    add({ type: "ci-pass" });
    add({ type: "ci-pass" }, { number: 8, title: "ORBIT-1043 other" });
    const box = { s: at(OLD, [chk("a", "pending")]) };
    const read = async () => box.s;
    await W.checkWatches(read); // both armed on a run still going
    box.s = at(OLD, [chk("a", "success")]);
    expect(await W.checkWatches(read)).toBe(1);
    expect(fired.map((f) => f.number)).toEqual([8]);
    expect(watchOf(7).active).toBe(true);
  });
  it("a sync on another repo's PR with the same number holds nothing here", async () => {
    W.noteSync("acme/other", 7, OLD);
    add({ type: "ci-pass" });
    const { box, read } = reader(at(OLD, [chk("a", "pending")]));
    await W.checkWatches(read);
    box.s = at(OLD, [chk("a", "success")]);
    expect(await W.checkWatches(read)).toBe(1);
  });
  it("no sync heard: the current head's run turning green fires", async () => {
    add({ type: "ci-pass" });
    const { box, read } = reader(at(OLD, [chk("a", "pending")]));
    await W.checkWatches(read);
    box.s = at(OLD, [chk("a", "success")]);
    expect(await W.checkWatches(read)).toBe(1);
  });
});

describe("a sync that changed nothing says so, in words", () => {
  const t0 = 1_000_000;
  it("while the wait is open it is 'waiting', afterwards 'unchanged' and the watch goes back to the current head", async () => {
    W.noteSync("acme/orbit", 7, OLD, t0);
    add({ type: "ci-pass" });
    const { box, read } = reader(at(OLD, [chk("a", "pending")]));
    expect(await W.checkWatches(read, t0 + 10_000)).toBe(0);
    expect(watchOf().sync).toEqual({ state: "waiting", from: OLD });
    expect(watchOf().head).toBe(OLD);
    expect(await W.checkWatches(read, t0 + W.SYNC_WAIT_MS + 1)).toBe(0);
    expect(watchOf().sync).toEqual({ state: "unchanged", from: OLD });
    box.s = at(OLD, [chk("a", "success")]);
    expect(await W.checkWatches(read, t0 + W.SYNC_WAIT_MS + 2)).toBe(1);
    expect(fired[0]!.detail).toContain("did not change the head");
  });
  it("an old run already green when the wait runs out is NOT announced: the words are the answer", async () => {
    W.noteSync("acme/orbit", 7, OLD, t0);
    add({ type: "ci-pass" });
    const { box, read } = reader(at(OLD, [chk("a", "success")]));
    expect(await W.checkWatches(read, t0 + 1_000)).toBe(0);
    expect(await W.checkWatches(read, t0 + W.SYNC_WAIT_MS + 1)).toBe(0);
    expect(await W.checkWatches(read, t0 + W.SYNC_WAIT_MS + 2)).toBe(0);
    expect(fired.length).toBe(0);
    expect(watchOf().active).toBe(true);
    expect(watchOf().sync?.state).toBe("unchanged");
    // a re-run of the same head is a new run, and its result is news
    box.s = at(OLD, [chk("a", "pending")]);
    await W.checkWatches(read, t0 + W.SYNC_WAIT_MS + 3);
    box.s = at(OLD, [chk("a", "success")]);
    expect(await W.checkWatches(read, t0 + W.SYNC_WAIT_MS + 4)).toBe(1);
    expect(fired[0]!.detail).toContain("did not change the head");
  });
  it("a head that moves after the note is a normal head again", async () => {
    W.noteSync("acme/orbit", 7, OLD, t0);
    add({ type: "ci-pass" });
    const { box, read } = reader(at(OLD, [chk("a", "pending")]));
    await W.checkWatches(read, t0 + W.SYNC_WAIT_MS + 1);
    box.s = at(NEW, [chk("a", "pending")]);
    await W.checkWatches(read, t0 + W.SYNC_WAIT_MS + 2);
    expect(watchOf().sync).toBeUndefined();
    expect(watchOf().head).toBe(NEW);
  });
  it("the chip is told: a change of head or of sync state is broadcast, an unchanged read is not", async () => {
    let n = 0;
    const off = W.subscribeWatchChange(() => { n++; });
    add({ type: "ci-pass" });
    const base = n;
    const { box, read } = reader(at(OLD, [chk("a", "pending")]));
    await W.checkWatches(read);
    const afterFirst = n;
    expect(afterFirst).toBeGreaterThan(base);
    await W.checkWatches(read);
    expect(n).toBe(afterFirst);
    box.s = at(NEW, [chk("a", "pending")]);
    await W.checkWatches(read);
    expect(n).toBeGreaterThan(afterFirst);
    off();
  });
});

describe("the read budget around a sync", () => {
  it("a PR whose old head is green is read at the running cadence while it waits for the new one", async () => {
    W.noteSync("acme/orbit", 7, OLD);
    add({ type: "ci-pass" });
    const { read, box } = reader(at(OLD, [chk("a", "success")]));
    await W.checkWatches(read, 1_000, true);
    await W.checkWatches(read, 1_000 + W.RUNNING_READ_MS - 1, true);
    expect(box.calls).toBe(1);
    await W.checkWatches(read, 1_000 + W.RUNNING_READ_MS, true);
    expect(box.calls).toBe(2);
  });
  it("a head with no rollup at all and no sync waiting is still a read that found nothing: it backs off", async () => {
    add({ type: "ci-pass" });
    const { read, box } = reader(at(OLD, []));
    await W.checkWatches(read, 1_000, true);
    await W.checkWatches(read, 1_000 + W.RUNNING_READ_MS, true);
    expect(box.calls).toBe(1); // doubled to 60 s, not 30 s
  });
});

describe("wiring in the server", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  it("an accepted Update branch tells the watch, with the head it started from, and re-reads once", async () => {
    const ix = strip(await Bun.file(join(import.meta.dir, "../src/index.ts")).text());
    expect(ix).toContain('res = await updateBranch(root, n, b.syncLocal, (before) => noteSyncFor(root, n, before));');
    const fn = ix.slice(ix.indexOf("async function noteSyncFor("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("noteSync(id.nameWithOwner");
    expect(body).toContain("prNotifyKick()");
    // a refused press moves nothing, so it takes its note back (a branch GitHub moved while the PR lagged did sync)
    expect(ix).toMatch(/if \(!res\.ok && !res\.prLagging\) await dropSyncFor\(/);
  });
  it("the read hands the head over even when the new commit has no checks yet", async () => {
    const ix = strip(await Bun.file(join(import.meta.dir, "../src/index.ts")).text());
    expect(ix).toMatch(/if \(!r\.ok && r\.sha\) return \{ allDone: false, verdict: null, all: \[\]/);
    const prs = strip(await Bun.file(join(import.meta.dir, "../src/prs.ts")).text());
    expect(prs).toMatch(/if \(!raw\) return \{ ok: false, error: "GitHub would not list its checks", sha: /);
    const ub = prs.slice(prs.indexOf("export async function updateBranch("));
    expect(ub.slice(0, ub.indexOf("\n}\n"))).toContain("headBefore");
  });
});

const PAYLOAD_TITLE = (f: PrWatchFire) => f.payload?.title ?? "";

describe("the head is re-read when a rule is about to fire", () => {
  it("the head moved after the read: the old run is not announced, the watch waits on the new head", async () => {
    add({ type: "ci-pass" });
    const pending = reader(at(OLD, [chk("a", "pending")]));
    await W.checkWatches(pending.read); // armed on a run still going
    const seq = [at(OLD, [chk("a", "success")]), at(NEW, [])];
    let i = 0;
    const read = async () => seq[Math.min(i++, seq.length - 1)]!;
    expect(await W.checkWatches(read)).toBe(0);
    expect(fired.length).toBe(0);
    expect(watchOf().active).toBe(true);
    expect(watchOf().head).toBe(NEW);
  });
  it("the head moved and the new one is already green: it is announced, for the new commit", async () => {
    add({ type: "ci-pass" });
    await W.checkWatches(reader(at(OLD, [chk("a", "pending")])).read);
    const seq = [at(OLD, [chk("a", "success")]), at(NEW, [chk("a", "success")])];
    let i = 0;
    expect(await W.checkWatches(async () => seq[Math.min(i++, 1)]!)).toBe(1);
    expect(fired[0]!.summary).toBe("CI passed on bbbbbbb");
  });
  it("one extra request, only when something is about to fire", async () => {
    add({ type: "ci-pass" });
    const idle = reader(at(OLD, [chk("a", "pending")]));
    await W.checkWatches(idle.read);
    expect(idle.box.calls).toBe(1);
    idle.box.s = at(OLD, [chk("a", "success")]);
    await W.checkWatches(idle.read);
    expect(idle.box.calls).toBe(3);
  });
  it("a re-read that fails confirms nothing: no fire, asked again next time", async () => {
    add({ type: "ci-pass" });
    await W.checkWatches(reader(at(OLD, [chk("a", "pending")])).read);
    let i = 0;
    const read = async () => (i++ === 0 ? at(OLD, [chk("a", "success")]) : null);
    expect(await W.checkWatches(read)).toBe(0);
    expect(watchOf().active).toBe(true);
    expect(await W.checkWatches(reader(at(OLD, [chk("a", "success")])).read)).toBe(1);
  });
});

describe("a rule armed on a run that is already green", () => {
  it("says so on the watch and does not fire", async () => {
    add({ type: "ci-pass" });
    expect(await W.checkWatches(reader(at(OLD, [chk("a", "success")])).read)).toBe(0);
    expect(fired.length).toBe(0);
    expect(W.pendingFires().length).toBe(0);
    expect(watchOf().active).toBe(false);
    expect(watchOf().lastText).toBe("Already green on aaaaaaa");
  });
  it("a check rule armed on a check that already passed says the same", async () => {
    add({ type: "check", match: "evals", on: "pass" });
    expect(await W.checkWatches(reader(at(OLD, [chk("evals", "success")])).read)).toBe(0);
    expect(watchOf().lastText).toBe("evals already passed on aaaaaaa");
  });
  it("armed on a run still going, the same run turning green fires", async () => {
    add({ type: "ci-pass" });
    const { box, read } = reader(at(OLD, [chk("a", "pending")]));
    await W.checkWatches(read);
    box.s = at(OLD, [chk("a", "success")]);
    expect(await W.checkWatches(read)).toBe(1);
  });
  it("armed while the old head is held for a sync, the new head's green fires even if it is green when first seen", async () => {
    W.noteSync("acme/orbit", 7, OLD);
    add({ type: "ci-pass" });
    const { box, read } = reader(at(OLD, [chk("a", "success")]));
    await W.checkWatches(read);
    box.s = at(NEW, [chk("a", "success")]);
    expect(await W.checkWatches(read)).toBe(1);
  });
  it("a failing run still fires when armed on it", async () => {
    add({ type: "ci-fail" });
    expect(await W.checkWatches(reader(at(OLD, [chk("a", "failure")])).read)).toBe(1);
  });
  it("pressing the bell again on a spent rule starts the question over", async () => {
    add({ type: "ci-pass" });
    await W.checkWatches(reader(at(OLD, [chk("a", "success")])).read);
    expect(watchOf().active).toBe(false);
    add({ type: "ci-pass" });
    expect(watchOf().active).toBe(true);
    const { box, read } = reader(at(OLD, [chk("a", "pending")]));
    await W.checkWatches(read);
    box.s = at(OLD, [chk("a", "success")]);
    expect(await W.checkWatches(read)).toBe(1);
  });
});

describe("the notification says which commit it is about", () => {
  it("the title carries the short commit", async () => {
    add({ type: "ci-pass" });
    const { box, read } = reader(at(NEW, [chk("a", "pending")]));
    await W.checkWatches(read);
    box.s = at(NEW, [chk("a", "success")]);
    await W.checkWatches(read);
    expect(PAYLOAD_TITLE(fired[0]!)).toBe("CI passed on bbbbbbb · acme/orbit #7");
    expect(watchOf().lastText).toBe("CI passed on bbbbbbb");
  });
  it("a failure names it too", async () => {
    add({ type: "ci-fail" });
    await W.checkWatches(reader(at(OLD, [chk("a", "failure")])).read);
    expect(fired[0]!.summary).toBe("CI failed on aaaaaaa");
  });
});

describe("a sync still in flight", () => {
  it("armed before the press is answered, the old head's green is held; a refused press takes its note back", async () => {
    W.noteSync("acme/orbit", 7, OLD); // the press began: written down before GitHub answers
    add({ type: "ci-pass" });
    const { box, read } = reader(at(OLD, [chk("a", "success")]));
    expect(await W.checkWatches(read)).toBe(0);
    expect(watchOf().sync?.state).toBe("waiting");
    W.dropSync("acme/orbit", 7);
    expect(watchOf().sync).toBeUndefined();
    box.s = at(OLD, [chk("a", "pending")]);
    await W.checkWatches(read);
    box.s = at(OLD, [chk("a", "success")]);
    expect(await W.checkWatches(read)).toBe(1);
  });
});
