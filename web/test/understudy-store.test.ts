/*
 * The one property that decides whether the understudy view paints at all.
 *
 * useSyncExternalStore compares snapshots BY IDENTITY. A getSnapshot that
 * builds a fresh object per call reports a change on every render, which
 * schedules a render, which reports a change — React gives up and paints
 * nothing, and what the user sees is a black window seconds after opening a
 * view that worked yesterday. This app has already shipped that once; the same
 * note is on `loadRail` in workspace/views.ts and on chatStore's snapshot.
 *
 * So there are three assertions here and they are all the same assertion from
 * different sides: identity is stable while the scorecard is, identity changes
 * when the scorecard does, and a frame that says nothing new fires nobody.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { UnderstudyClassRow, UnderstudyFrame } from "../../shared/types.ts";

// understudyStore reaches api.ts for the origin and the auth headers, and
// api.ts reads `location` and `localStorage` at module scope. Without these it
// throws half-initialised and every import in this file dies on a TDZ for
// SERVER — which reads as "the store is broken" rather than "the harness has no
// DOM". Same stubs, and the same reason, as chords.test.ts.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;
(globalThis as unknown as { location: URL }).location ??= new URL("http://localhost:5173/");

const { applyUnderstudy, getUnderstudy, subscribeUnderstudy } = await import("../src/lib/understudyStore.ts");
const { emitUnderstudy } = await import("../src/lib/understudyBus.ts");

/** One class row, at the shape the scorecard actually pushes. */
const row = (over: Partial<UnderstudyClassRow> = {}): UnderstudyClassRow => ({
  id: "C1",
  label: "worktree/branch start",
  lock: "earn",
  mode: "shadow",
  offered: false,
  n: 12,
  hits: 9,
  raw: 0.75,
  lb: 0.4681,
  bank: 3,
  blocked: ["n"],
  // The four the server computes so the panel never re-derives a threshold —
  // see the note on `countMet` in shared/types.ts.
  countMet: false,
  countBar: 80,
  agreementMet: false,
  baseRaw: 0.5,
  baseN: 12,
  agreementBarAt: 0.7,
  ...over,
});

/** A whole frame. Built fresh each time on purpose: what is under test is
 *  whether the STORE keeps one object, not whether a test reuses one. */
const frame = (over: Partial<UnderstudyFrame> = {}): UnderstudyFrame => ({
  asOf: 1_700_000_000_000,
  halted: false,
  enabled: true,
  level: "shadow",
  classes: [row(), row({ id: "C2", label: "local commit + message", n: 40, hits: 31 })],
  // The two aggregates the server computes so the panel never divides them out.
  agreement: 77,
  toNextRung: 40,
  seals: { sealed: 52, predicted: 52, late: 1, unsealed: 0, lastUnsealed: 0, lastLate: 0 },
  ...over,
});

/** Every listener this file registers, torn down between tests — the store is
 *  a module-level singleton and a leaked subscriber would count somebody else's
 *  frames. */
const cleanup: (() => void)[] = [];
const listen = (fn: () => void) => { const off = subscribeUnderstudy(fn); cleanup.push(off); return off; };
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

describe("the understudy snapshot", () => {
  it("is the same object when nothing has changed", () => {
    applyUnderstudy(frame({ asOf: 1 }));
    const a = getUnderstudy();
    const b = getUnderstudy();
    expect(a).toBe(b);
    // And still the same after an unrelated read — there is no lazy rebuild
    // hiding behind the getter.
    expect(getUnderstudy()).toBe(a);
  });

  it("is a new object after a frame that says something different", () => {
    applyUnderstudy(frame({ asOf: 2 }));
    const before = getUnderstudy();
    applyUnderstudy(frame({ asOf: 3 }));
    const after = getUnderstudy();
    expect(after).not.toBe(before);
    expect(after?.asOf).toBe(3);
  });

  it("keeps the old object when an identical frame arrives", () => {
    applyUnderstudy(frame({ asOf: 4 }));
    const before = getUnderstudy();
    // A different object carrying the same scorecard: this is what the server's
    // next push looks like when nothing has moved.
    applyUnderstudy(frame({ asOf: 4 }));
    expect(getUnderstudy()).toBe(before);
  });
});

describe("who gets told", () => {
  it("fires nobody for an identical frame", () => {
    applyUnderstudy(frame({ asOf: 5 }));
    let fired = 0;
    listen(() => { fired++; });
    applyUnderstudy(frame({ asOf: 5 }));
    applyUnderstudy(frame({ asOf: 5 }));
    expect(fired).toBe(0);
  });

  it("fires once for a frame that moved a number", () => {
    applyUnderstudy(frame({ asOf: 6 }));
    let fired = 0;
    listen(() => { fired++; });
    applyUnderstudy(frame({ asOf: 6, classes: [row(), row({ id: "C2", n: 41, hits: 32 })] }));
    expect(fired).toBe(1);
    expect(getUnderstudy()?.classes[1]?.n).toBe(41);
  });

  it("notices a class being offered, which is the one flag that matters", () => {
    applyUnderstudy(frame({ asOf: 7 }));
    let fired = 0;
    listen(() => { fired++; });
    // Same counts, same mode — only `offered` moved. A comparison that skipped
    // it would leave the panel saying "shadow, not eligible" over a class the
    // server is ready to have promoted, which is the single statement this
    // whole feature exists to make.
    applyUnderstudy(frame({ asOf: 7, classes: [row({ offered: true }), row({ id: "C2", n: 40, hits: 31 })] }));
    expect(fired).toBe(1);
  });

  it("notices the process being halted with the same scorecard behind it", () => {
    applyUnderstudy(frame({ asOf: 8 }));
    let fired = 0;
    listen(() => { fired++; });
    applyUnderstudy(frame({ asOf: 8, halted: true }));
    expect(fired).toBe(1);
    expect(getUnderstudy()?.halted).toBe(true);
  });

  it("stops telling a listener that has unsubscribed", () => {
    applyUnderstudy(frame({ asOf: 9 }));
    let fired = 0;
    const off = listen(() => { fired++; });
    off();
    applyUnderstudy(frame({ asOf: 10 }));
    expect(fired).toBe(0);
  });
});

describe("the socket's frame reaches the store", () => {
  it("without the panel wiring anything up", () => {
    // The store subscribes to the bus at module load, so a frame that arrives
    // before any component mounts is still kept. useLive calls exactly this.
    let fired = 0;
    listen(() => { fired++; });
    emitUnderstudy(frame({ asOf: 11, seals: { sealed: 99, predicted: 98, late: 2, unsealed: 1, lastUnsealed: 0, lastLate: 0 } }));
    expect(fired).toBe(1);
    expect(getUnderstudy()?.asOf).toBe(11);
    expect(getUnderstudy()?.seals.unsealed).toBe(1);
  });
});
