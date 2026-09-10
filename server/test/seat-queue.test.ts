/*
 * THE SEAT'S QUEUE — the four promises that keep a list of work from eating it.
 *
 * Every one of these is a bug the clone's own queue shipped first: a claim
 * stamped at the end instead of the start, an item re-offered for ever after
 * it beat two agents, a row left claimed by an agent that no longer exists,
 * and two takers of one item.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-seatq-"));
process.env.AGENTGLASS_DOCTRINE = join(dir, "data");

const Q = await import("../src/seatqueue.ts");
const { db } = await import("../src/db.ts");

const ROOT = "/home/a/code/orbit";
const OTHER = "/home/a/code/other";
const add = (title: string, weight = 0, root = ROOT) => {
  const r = Q.addTask({ root, title, weight });
  if (!r.ok) throw new Error(r.error);
  return r.task;
};

beforeEach(() => { db.query("DELETE FROM seat_task").run(); });

describe("what goes on the list", () => {
  test("a task needs a title, and the title is one line", () => {
    expect(Q.addTask({ root: ROOT, title: "   " }).ok).toBe(false);
    const t = add("  two\n  lines  ");
    expect(t.title).toBe("two lines");
  });

  test("each project keeps its own list", () => {
    add("orbit work");
    add("other work", 0, OTHER);
    expect(Q.tasksFor(ROOT).map((t) => t.title)).toEqual(["orbit work"]);
    expect(Q.tasksFor(OTHER).map((t) => t.title)).toEqual(["other work"]);
  });
});

describe("what is handed out next", () => {
  test("the heaviest first, then the oldest", () => {
    add("light", 1);
    const heavy = add("heavy", 5);
    expect(Q.nextTask(ROOT)?.id).toBe(heavy.id);
  });

  test("never something already out with somebody", () => {
    const t = add("only one");
    Q.claimTask(t.id, "agent-a");
    expect(Q.nextTask(ROOT)).toBeNull();
  });

  test("never something already done", () => {
    const t = add("only one");
    Q.claimTask(t.id, "agent-a");
    Q.finishTask(t.id, "shipped");
    expect(Q.nextTask(ROOT)).toBeNull();
  });

  test("and never one that has beaten MAX_ATTEMPTS agents", () => {
    /* An item two agents could not finish needs a person to read it. A queue
       that keeps offering it burns a turn every time the seat wakes. */
    const t = add("cursed");
    for (let i = 0; i < Q.MAX_ATTEMPTS; i++) {
      Q.claimTask(t.id, `agent-${i}`);
      Q.releaseTask(t.id);
    }
    expect(Q.taskById(t.id)?.attempts).toBe(Q.MAX_ATTEMPTS);
    expect(Q.nextTask(ROOT)).toBeNull();
    /* Still on the list, though — it is work, not a mistake. */
    expect(Q.tasksFor(ROOT)).toHaveLength(1);
  });
});

describe("the claim is stamped when the work STARTS", () => {
  test("so a task that came back with nothing is not pending again", () => {
    /* The clone stamped this at the END once: everything that failed looked
       untouched, and the next round took it straight back up against the
       checkout the failure had left behind. */
    const t = add("risky");
    const got = Q.claimTask(t.id, "agent-a")!;
    expect(got.takenAt).toBeGreaterThan(0);
    expect(got.takenBy).toBe("agent-a");
    expect(Q.nextTask(ROOT)).toBeNull();
  });

  test("two seats waking at once cannot both take it", () => {
    const t = add("one item");
    const first = Q.claimTask(t.id, "agent-a");
    const second = Q.claimTask(t.id, "agent-b");
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(Q.taskById(t.id)?.takenBy).toBe("agent-a");
  });

  test("and a claim counts as an attempt even when nothing comes back", () => {
    const t = add("counts");
    Q.claimTask(t.id, "agent-a");
    expect(Q.taskById(t.id)?.attempts).toBe(1);
  });
});

describe("work whose agent vanished comes back to the list", () => {
  test("released when the name is not alive any more", () => {
    const t = add("carried");
    Q.claimTask(t.id, "agent-gone");
    expect(Q.releaseVanished(ROOT, new Set(["someone-else"]))).toEqual([t.id]);
    const back = Q.taskById(t.id)!;
    expect(back.takenAt).toBeNull();
    expect(back.takenBy).toBe("");
    /* The attempt is KEPT: otherwise the ceiling never arrives and a task that
       kills its agent every time is offered for ever. */
    expect(back.attempts).toBe(1);
    expect(Q.nextTask(ROOT)?.id).toBe(t.id);
  });

  test("left alone while the agent is alive", () => {
    const t = add("in hand");
    Q.claimTask(t.id, "agent-alive");
    expect(Q.releaseVanished(ROOT, new Set(["agent-alive"]))).toEqual([]);
    expect(Q.taskById(t.id)?.takenBy).toBe("agent-alive");
  });

  test("a finished one is never resurrected by a vanished agent", () => {
    const t = add("done and gone");
    Q.claimTask(t.id, "agent-gone");
    Q.finishTask(t.id, "shipped");
    expect(Q.releaseVanished(ROOT, new Set())).toEqual([]);
    expect(Q.taskById(t.id)?.doneAt).toBeGreaterThan(0);
  });
});

describe("what the seat is told about its queue", () => {
  test("says what is waiting, what is out, and with whom", () => {
    add("waiting one");
    const out = add("out one");
    Q.claimTask(out.id, "agent-a");
    const text = Q.queueReadout(ROOT);
    expect(text).toContain("Waiting (1)");
    expect(text).toContain("waiting one");
    expect(text).toContain("out one → agent-a");
  });

  test("names the beaten ones and tells it not to hand them out", () => {
    const t = add("cursed");
    for (let i = 0; i < Q.MAX_ATTEMPTS; i++) { Q.claimTask(t.id, `a${i}`); Q.releaseTask(t.id); }
    const text = Q.queueReadout(ROOT);
    expect(text).toContain("do NOT hand these out again");
    expect(text).toContain("cursed");
  });

  test("an empty queue says so rather than drawing a heading over nothing", () => {
    expect(Q.queueReadout(ROOT)).toContain("Nothing is waiting");
  });
});

describe("what would prove it done travels with the work", () => {
  test("the readout names the proof, and names its absence", () => {
    /* An orchestration contract without an observable acceptance is a contract
       whose "finished" is prose — the failure every published one exists to
       prevent, and the one people report most in practice. */
    Q.addTask({ root: ROOT, title: "with proof", proof: "bun test server/test/export.test.ts is green" });
    Q.addTask({ root: ROOT, title: "without proof" });
    const text = Q.queueReadout(ROOT);
    expect(text).toContain("done when: bun test server/test/export.test.ts is green");
    expect(text).toContain("NOT STATED");
  });

  test("the id is in the readout, so the seat can claim what it just read", () => {
    const t = add("claimable");
    expect(Q.queueReadout(ROOT)).toContain(`[${t.id}]`);
  });

  test("an unstated proof is allowed rather than refused", () => {
    /* Refusing it would push people to type something to get past the field,
       and a made-up proof is worse than an admitted absence. */
    const r = Q.addTask({ root: ROOT, title: "no proof yet" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.proof).toBe("");
  });
});
