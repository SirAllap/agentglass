/*
 * How far behind each branch is, asked for the cards on screen and nobody else.
 *
 * The compare costs a network call per pull request and is not on the list
 * payload, so the store's rules are what keep a board from turning into a dozen
 * comparisons: a five-minute memory, three at once, and a failure remembered as
 * "no answer" so a failed read is not retried on every paint.
 *
 * Injected I/O and an injected clock, so the rules are held by a test rather
 * than by a screen.
 */
import { describe, expect, test } from "bun:test";
import type { Host } from "../src/lib/host.ts";
import { BEHIND_TTL_MS, createBehindStore } from "../src/state/pr-behind.ts";

const host = (token = "t1"): Host =>
  ({ origin: "http://192.168.1.20:4000", token, label: "orbit phone", scope: "full", pairedAt: 0 }) as Host;

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Answers held until the test lets them go, so "in flight" can be counted. */
function gate() {
  const open: (() => void)[] = [];
  let inFlight = 0;
  let peak = 0;
  const wait = <T>(v: T): Promise<T> => {
    inFlight++; peak = Math.max(peak, inFlight);
    return new Promise((res) => { open.push(() => { inFlight--; res(v); }); });
  };
  return { wait, open, peak: () => peak };
}

describe("the compare's budget", () => {
  test("three at once, and the rest queue behind them", async () => {
    const w = gate();
    let asked = 0;
    const store = createBehindStore(async () => { asked++; return w.wait({ ok: true, behind: 2 }); });
    for (let n = 1; n <= 8; n++) store.of(host(), "/w/orbit", n);
    expect(asked).toBe(3);
    // Each landing starts the next, and never a fourth at once.
    for (let done = 0; done < 8; done++) { w.open.shift()!(); await tick(); }
    expect(asked).toBe(8);
    expect(w.peak()).toBe(3);
  });

  test("a card nobody has drawn asks nothing", () => {
    let asked = 0;
    const store = createBehindStore(async () => { asked++; return { ok: true, behind: 0 }; });
    expect(store.known(host(), "/w/orbit", 1)).toBeNull();
    expect(store.asking(host(), "/w/orbit", 1)).toBe(true);
    expect(asked).toBe(0);
  });
});

describe("what the store remembers", () => {
  test("one ask per card per five minutes, and the last answer stands while it re-asks", async () => {
    let clock = 1_000;
    let asked = 0;
    const store = createBehindStore(async () => { asked++; return { ok: true, behind: 4 }; }, () => clock);
    store.of(host(), "/w/orbit", 1);
    await tick();
    expect(store.of(host(), "/w/orbit", 1)).toBe(4);
    expect(store.of(host(), "/w/orbit", 1)).toBe(4);
    expect(asked).toBe(1);

    clock += BEHIND_TTL_MS;
    // Past the line it asks again, and the card keeps drawing 4 meanwhile.
    expect(store.of(host(), "/w/orbit", 1)).toBe(4);
    expect(asked).toBe(2);
    expect(store.asking(host(), "/w/orbit", 1)).toBe(false);
  });

  test("a failure is remembered as no answer, and not re-asked on every paint", async () => {
    let asked = 0;
    const store = createBehindStore(async () => { asked++; return { ok: false, error: "no" }; });
    store.of(host(), "/w/orbit", 1);
    await tick();
    expect(store.of(host(), "/w/orbit", 1)).toBeNull();
    expect(store.of(host(), "/w/orbit", 1)).toBeNull();
    expect(asked).toBe(1);
    // The space is kept: it is a failure, not a first look.
    expect(store.asking(host(), "/w/orbit", 1)).toBe(false);
  });

  /*
   * A failure is a fact the card has to be able to see. Held only as
   * `behind: null` it is indistinguishable from a first look that is still
   * out, and the difference is what keeps the branch cell from printing
   * "up to date" over a compare that never answered.
   */
  test("a failed compare says it failed, and an answer clears that", async () => {
    let clock = 1_000;
    let fail = true;
    const store = createBehindStore(async () => (fail ? { ok: false, error: "gh: not signed in" } : { ok: true, behind: 3 }), () => clock);
    store.of(host(), "/w/orbit", 1);
    await tick();
    expect(store.failed(host(), "/w/orbit", 1)).toBe(true);
    expect(store.asking(host(), "/w/orbit", 1)).toBe(false);

    fail = false;
    clock += BEHIND_TTL_MS;
    store.of(host(), "/w/orbit", 1);
    await tick();
    expect(store.failed(host(), "/w/orbit", 1)).toBe(false);
    expect(store.of(host(), "/w/orbit", 1)).toBe(3);
  });

  test("a throw is a failure on the same terms", async () => {
    const store = createBehindStore(async () => { throw new Error("boom"); });
    store.of(host(), "/w/orbit", 2);
    await tick();
    expect(store.failed(host(), "/w/orbit", 2)).toBe(true);
  });

  test("a card nobody has asked about has not failed", () => {
    const store = createBehindStore(async () => ({ ok: true, behind: 0 }));
    expect(store.failed(host(), "/w/orbit", 9)).toBe(false);
    expect(store.failed(null, "/w/orbit", 9)).toBe(false);
  });

  test("a throw is a failure too, not a rejected queue", async () => {
    let asked = 0;
    const store = createBehindStore(async () => { asked++; throw new Error("boom"); });
    store.of(host(), "/w/orbit", 1);
    await tick();
    expect(store.known(host(), "/w/orbit", 1)).toBeNull();
    store.of(host(), "/w/orbit", 1);
    expect(asked).toBe(1);
  });

  test("the same pull request on two computers is two answers", async () => {
    let clock = 1_000;
    const store = createBehindStore(async (h) => ({ ok: true, behind: h.token === "a" ? 1 : 7 }), () => clock);
    store.of(host("a"), "/w/orbit", 4);
    store.of(host("b"), "/w/orbit", 4);
    await tick();
    expect(store.known(host("a"), "/w/orbit", 4)).toBe(1);
    expect(store.known(host("b"), "/w/orbit", 4)).toBe(7);
  });

  test("forgetting one computer leaves the other's answers", async () => {
    const store = createBehindStore(async () => ({ ok: true, behind: 3 }));
    store.of(host("a"), "/w/orbit", 1);
    store.of(host("b"), "/w/orbit", 1);
    await tick();
    store.forget(host("a"));
    expect(store.known(host("a"), "/w/orbit", 1)).toBeNull();
    expect(store.known(host("b"), "/w/orbit", 1)).toBe(3);
  });

  test("subscribers hear every answer land", async () => {
    const store = createBehindStore(async () => ({ ok: true, behind: 0 }));
    let landings = 0;
    const stop = store.subscribe(() => { landings++; });
    store.of(host(), "/w/orbit", 1);
    await tick();
    expect(landings).toBe(1);
    stop();
    store.of(host(), "/w/orbit", 2);
    await tick();
    expect(landings).toBe(1);
  });
});
