/*
 * A card the tracker says does not exist (a branch named ORBIT-1042 with no
 * such card) used to be asked for again on every tab switch: the find
 * wrapper threw on a miss, and a thrown load is never remembered (see
 * remote-store.test.ts, "a failed load is not remembered: the next call
 * retries") — intentional for a transport failure, wrong for a real "no"
 * from the tracker's own HTTP 200. `findOutcome` turns that "no" into a
 * cacheable value instead of a rejection.
 */
import { describe, expect, it } from "bun:test";
import { findOutcome } from "../src/components/TasksPanel.tsx";
import { load, resetRemoteStore } from "../src/lib/remoteStore.ts";

describe("findOutcome", () => {
  it("a miss (ok:false) is a value, not a throw", () => {
    const o = findOutcome({ ok: false, error: "not found" });
    expect(o).toEqual({ ok: false, error: "not found" });
  });

  it("a hit keeps the task", () => {
    const task = { id: "acme-1042" } as never;
    const o = findOutcome({ ok: true, task });
    expect(o).toEqual({ ok: true, task });
  });

  it("ok:true with no task is still a miss", () => {
    const o = findOutcome({ ok: true });
    expect(o.ok).toBe(false);
  });
});

describe("a cached miss", () => {
  it("a second switch asks nothing, within the TTL", async () => {
    resetRemoteStore();
    let calls = 0;
    const loader = () => { calls++; return Promise.resolve({ ok: false, error: "not found" }).then(findOutcome); };
    await load("card-find:clickup:acme-1042", loader, 60_000);
    await load("card-find:clickup:acme-1042", loader, 60_000);
    expect(calls).toBe(1);
  });

  it("a found card after the TTL still shows", async () => {
    resetRemoteStore();
    let calls = 0;
    const loader = () => {
      calls++;
      const answer = calls === 1 ? { ok: false, error: "not found" } : { ok: true, task: { id: "acme-1042" } as never };
      return Promise.resolve(answer).then(findOutcome);
    };
    await load("card-find:clickup:acme-1042", loader, 5);
    await new Promise((r) => setTimeout(r, 20));
    const second = await load("card-find:clickup:acme-1042", loader, 5);
    expect(calls).toBe(2);
    expect(second.ok).toBe(true);
  });
});
