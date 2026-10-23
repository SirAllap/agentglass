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
    expect(fired[0]!.summary).toBe("CI passed");
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
    const read = async () => at(OLD, [chk("a", "success")]);
    expect(await W.checkWatches(read)).toBe(1);
    expect(fired.map((f) => f.number)).toEqual([8]);
    expect(watchOf(7).active).toBe(true);
  });
  it("a sync on another repo's PR with the same number holds nothing here", async () => {
    W.noteSync("acme/other", 7, OLD);
    add({ type: "ci-pass" });
    expect(await W.checkWatches(reader(at(OLD, [chk("a", "success")])).read)).toBe(1);
  });
  it("no sync heard: today's behaviour, the current head's green fires at once", async () => {
    add({ type: "ci-pass" });
    expect(await W.checkWatches(reader(at(OLD, [chk("a", "success")])).read)).toBe(1);
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
    expect(ix).toContain('case "/prs/update-branch": res = await updateBranch(root, n, b.syncLocal);');
    const fn = ix.slice(ix.indexOf("async function noteSyncFor("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("noteSync(id.nameWithOwner");
    expect(body).toContain("prNotifyKick()");
    expect(ix).toMatch(/if \(res\.ok\) await noteSyncFor\(root, n, res\.headBefore\)/);
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
