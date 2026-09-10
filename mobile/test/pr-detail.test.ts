/*
 * One pull request, read once, however many panes are looking at it.
 *
 * Three of them are, since the review became one screen with three segments —
 * the overview, the diff and the threads. Two things had to become true for
 * that not to be a regression:
 *
 *   they make ONE request between them, not three;
 *   and a write in any of them re-reads for all three, so the count on the
 *   overview cannot still say "3 open" after you resolved one next door.
 *
 * `fetch` is stubbed rather than a server booted: the question is what this
 * store does with an answer, not what the server answers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { forgetPrDetail, prDetailNow, readPrDetail } from "../src/state/pr-detail.ts";
import type { Host } from "../src/lib/host.ts";

const host: Host = {
  origin: "http://192.168.7.20:4000",
  token: "a-device-token",
  label: "Test phone",
  scope: "full",
  pairedAt: 0,
};

const realFetch = globalThis.fetch;
let calls = 0;
/** A gate every stubbed read waits behind, so a second and third caller arrive
 *  while the first is still in flight — the only moment a join can be seen.
 *  Opened for ALL of them, so a broken join fails with the wrong count rather
 *  than hanging. */
let gate: { wait: Promise<void>; open: () => void } | null = null;

const answer = (title: string): Response =>
  new Response(JSON.stringify({ ok: true, detail: { number: 12, title, threads: [] } }), {
    status: 200, headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  calls = 0;
  forgetPrDetail("/code/widget", "12");
  // Typed like the stub in ask-refusals.test.ts: a bare async function is not
  // `typeof fetch` — that type carries `preconnect` — and the parameters are
  // what makes the cast honest rather than a silencer.
  globalThis.fetch = ((_url: string | URL | Request, _init?: RequestInit) => {
    calls++;
    const n = calls;
    return (gate ? gate.wait : Promise.resolve()).then(() => answer(`read ${n}`));
  }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = realFetch; gate = null; });

/** A gate that starts shut. */
function shut(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((go) => { open = go; });
  return { wait, open };
}

describe("three panes, one request", () => {
  test("callers that arrive while a read is in flight join it", async () => {
    gate = shut();
    const all = Promise.all([
      readPrDetail(host, "/code/widget", "12"),
      readPrDetail(host, "/code/widget", "12"),
      readPrDetail(host, "/code/widget", "12"),
    ]);
    gate.open();
    await all;
    expect(calls).toBe(1);
    expect(prDetailNow("/code/widget", "12")?.title).toBe("read 1");
  });

  test("and a later one is a fresh read, because a write must not see a cache", async () => {
    // What a thread looks like after a reply is GitHub's answer and not this
    // app's guess — the rule useThreadActions already states, which is worth
    // nothing if the re-read it makes is served from memory.
    gate = null;
    await readPrDetail(host, "/code/widget", "12");
    await readPrDetail(host, "/code/widget", "12");
    expect(calls).toBe(2);
    expect(prDetailNow("/code/widget", "12")?.title).toBe("read 2");
  });
});

describe("two pull requests are two answers", () => {
  test("nothing is shared between them", async () => {
    gate = null;
    await readPrDetail(host, "/code/widget", "12");
    await readPrDetail(host, "/code/widget", "13");
    expect(prDetailNow("/code/widget", "12")?.title).toBe("read 1");
    expect(prDetailNow("/code/widget", "13")?.title).toBe("read 2");
    forgetPrDetail("/code/widget", "13");
  });

  test("the same number in two checkouts is two things", async () => {
    // A worktree per pull request is how this project works; #12 of one
    // checkout is not #12 of another.
    gate = null;
    await readPrDetail(host, "/code/widget", "12");
    await readPrDetail(host, "/code/other", "12");
    expect(prDetailNow("/code/widget", "12")?.title).toBe("read 1");
    expect(prDetailNow("/code/other", "12")?.title).toBe("read 2");
    forgetPrDetail("/code/other", "12");
  });
});

describe("nothing to read", () => {
  test("no host, no root, no number: no request rather than a bad one", async () => {
    gate = null;
    await readPrDetail(null, "/code/widget", "12");
    await readPrDetail(host, "", "12");
    await readPrDetail(host, "/code/widget", "");
    expect(calls).toBe(0);
  });
});
