/*
 * The parked-request map behind a /control command that wants an answer, tested
 * without a server: the same four things settleBrowser is held to. A timeout
 * settles and leaves nothing behind, the first answer wins, a second or a late
 * one is ignored, and an id nobody was given settles nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  awaitControl, settleControl, parseReply, nextControlRid, callerRequestId, resetControl, pendingControlCount,
  CONTROL_TIMEOUT_ERROR,
} from "../src/control.ts";

afterEach(() => resetControl());

describe("awaitControl / settleControl", () => {
  test("an answer settles the request with exactly what the window said", async () => {
    const rid = nextControlRid();
    const p = awaitControl(rid, () => {}, 1000);
    expect(pendingControlCount()).toBe(1);
    expect(settleControl(rid, { ok: true, applied: true, value: { state: { view: "git" } } })).toBe(true);
    expect(await p).toEqual({ ok: true, applied: true, value: { state: { view: "git" } } });
    expect(pendingControlCount()).toBe(0);
  });

  test("the first answer wins and a duplicate is ignored", async () => {
    const rid = nextControlRid();
    const p = awaitControl(rid, () => {}, 1000);
    expect(settleControl(rid, { ok: true, applied: true, value: "first" })).toBe(true);
    expect(settleControl(rid, { ok: true, applied: true, value: "second" })).toBe(false);
    expect((await p).value).toBe("first");
  });

  test("no answer in time settles with a named timeout and leaves no entry, and a late answer is ignored", async () => {
    const rid = nextControlRid();
    const r = await awaitControl(rid, () => {}, 20);
    expect(r).toEqual({ ok: false, applied: false, error: CONTROL_TIMEOUT_ERROR });
    expect(pendingControlCount()).toBe(0);
    expect(settleControl(rid, { ok: true, applied: true })).toBe(false);
  });

  test("the request is parked before the frame is sent, so an answer that races the send still lands", async () => {
    const rid = nextControlRid();
    const p = awaitControl(rid, () => { expect(settleControl(rid, { ok: true, applied: true, value: 1 })).toBe(true); }, 1000);
    expect((await p).value).toBe(1);
  });

  test("a send that throws settles at once instead of waiting out the timeout", async () => {
    const rid = nextControlRid();
    const r = await awaitControl(rid, () => { throw new Error("socket gone"); }, 5000);
    expect(r.ok).toBe(false);
    expect(pendingControlCount()).toBe(0);
  });

  test("an id nobody was given, or not a string, settles nothing", () => {
    expect(settleControl("c1-not-minted", { ok: true, applied: true })).toBe(false);
    expect(settleControl(undefined, { ok: true, applied: true })).toBe(false);
    expect(settleControl(42, { ok: true, applied: true })).toBe(false);
  });

  test("request ids cannot be counted to: each carries a random part", () => {
    const a = nextControlRid(), b = nextControlRid();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^c\d+-[0-9a-f-]{36}$/);
  });
});

describe("parseReply", () => {
  test("keeps the closed shape and drops everything else a window might add", () => {
    expect(parseReply({ ok: true, applied: true, value: { a: 1 }, error: "x", extra: "no", rid: "y" })).toEqual({ ok: true, applied: true, value: { a: 1 }, error: "x" });
    expect(parseReply({ ok: "yes", applied: 1 })).toEqual({ ok: false, applied: false });
  });

  test("not an object is no reply", () => {
    for (const bad of [null, "x", 3, [1], undefined]) expect(parseReply(bad)).toBeNull();
  });

  test("a value over the cap is refused, not truncated into something that looks whole", () => {
    const r = parseReply({ ok: true, applied: true, value: { text: "a".repeat(70 * 1024) } })!;
    expect(r.ok).toBe(false);
    expect(r.value).toBeUndefined();
    expect(r.error).toContain("refused");
  });

  test("a value that is not plain data is refused", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(parseReply({ ok: true, applied: true, value: loop })!.ok).toBe(false);
  });

  test("token-shaped text is stripped from the value and the error before an agent sees it", () => {
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const r = parseReply({ ok: false, applied: false, error: `bad ${token}`, value: { untrusted: { note: `use ${token} now` }, state: { n: 1 } } })!;
    expect(JSON.stringify(r)).not.toContain(token);
    expect((r.value as { state: { n: number } }).state.n).toBe(1);
  });
});

describe("callerRequestId", () => {
  test("is a slug the caller may use as a label, nothing else", () => {
    expect(callerRequestId("read-chat.1")).toBe("read-chat.1");
    for (const bad of ["", "a b", "x\ny", "../x", 5, null, "a".repeat(65)]) expect(callerRequestId(bad)).toBeNull();
  });
});
