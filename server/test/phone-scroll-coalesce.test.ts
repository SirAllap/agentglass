import { test, expect } from "bun:test";
import { scrollPhonePane } from "../src/tmuxctl.ts";

const sock = ["-L", "t"];
const sess = "agx-phone-1-ab";
const ok = (by: number) => ({ paneId: "%1", entered: false, inMode: true, by });
const gate = () => { let go!: () => void; const p = new Promise<void>((r) => (go = r)); return { p, go }; };

test("burst of 5 runs 2 calls with summed deltas", async () => {
  const calls: number[] = []; const g = gate();
  const once = async (_s: string[], _p: string, by: number) => { calls.push(by); if (calls.length === 1) await g.p; return ok(by) as any; };
  const ps = [-1, -2, -3, -4, -5].map((n) => scrollPhonePane(sock, sess, n, once));
  g.go(); await Promise.all(ps);
  expect(calls).toEqual([-1, -14]);
});

test("a throw frees the key and answers waiters null", async () => {
  const g = gate(); let n = 0;
  const once = async () => { n++; await g.p; throw new Error("boom"); };
  const a = scrollPhonePane(sock, sess, -1, once as any);
  const b = scrollPhonePane(sock, sess, -2, once as any);
  g.go();
  await expect(a).rejects.toThrow("boom");
  expect(await b).toBeNull();
  const calls: number[] = [];
  await scrollPhonePane(sock, sess, -3, (async (_s: any, _p: any, by: number) => (calls.push(by), ok(by))) as any);
  expect(calls).toEqual([-3]);
});

test("-8 then +8 spawns nothing", async () => {
  const calls: number[] = []; const g = gate();
  const once = async (_s: string[], _p: string, by: number) => { calls.push(by); if (calls.length === 1) await g.p; return ok(by) as any; };
  const a = scrollPhonePane(sock, sess, -1, once);
  const b = scrollPhonePane(sock, sess, -8, once);
  const c = scrollPhonePane(sock, sess, 8, once);
  g.go(); await a;
  expect(await b).toBeNull(); expect(await c).toBeNull();
  expect(calls).toEqual([-1]);
});

test("distance over 500 loops in clamped calls", async () => {
  const calls: number[] = [];
  await scrollPhonePane(sock, sess, -1200, (async (_s: any, _p: any, by: number) => (calls.push(by), ok(by))) as any);
  expect(calls).toEqual([-500, -500, -200]);
});

test("first caller settles before the follow-up", async () => {
  const order: string[] = []; const g = gate();
  const once = async (_s: string[], _p: string, by: number) => { if (by === -1) await g.p; return ok(by) as any; };
  const a = scrollPhonePane(sock, sess, -1, once).then(() => order.push("a"));
  const b = scrollPhonePane(sock, sess, -2, once).then(() => order.push("b"));
  g.go(); await Promise.all([a, b]);
  expect(order).toEqual(["a", "b"]);
});

test("a huge distance is capped instead of looping thousands of spawns", async () => {
  const calls: number[] = [];
  await scrollPhonePane(sock, sess, 1e9, (async (_s: any, _p: any, by: number) => (calls.push(by), ok(by))) as any);
  expect(calls.reduce((a, b) => a + b, 0)).toBe(5000);
  expect(calls.length).toBe(10);
});

test("a later chunk failing keeps the copy mode an earlier one entered", async () => {
  let n = 0;
  const got = await scrollPhonePane(sock, sess, -1000, (async (_s: any, _p: any, by: number) =>
    ++n === 1 ? { ...ok(by), entered: true } : null) as any);
  expect(got).not.toBeNull();
  expect(got!.entered).toBe(true);
});
