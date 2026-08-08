/*
 * Which pull requests may interrupt you about their checks.
 *
 * Asked for as "only when the PR is approved". A suite finishing is news whose
 * weight depends on where the pull request is: on something half-written it is
 * a status line you would glance at, on something approved it is the last thing
 * between you and merging.
 */
import { beforeEach, describe, expect, it } from "bun:test";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage;

const load = async () =>
  (await import(`../src/lib/ciNotifyPref.ts?t=${Math.random()}`)) as typeof import("../src/lib/ciNotifyPref.ts");

beforeEach(() => store.clear());

describe("with the setting on, which is the default", () => {
  it("lets an approved pull request through", async () => {
    const m = await load();
    expect(m.ciOnlyApproved()).toBe(true);
    expect(m.ciShouldNotify({ approved: true })).toBe(true);
  });

  it("holds one that nobody has approved", async () => {
    const m = await load();
    expect(m.ciShouldNotify({ approved: false })).toBe(false);
  });

  it("lets a verdict through when the server did not say", async () => {
    /*
     * A server one version behind sends no `approved`. The honest reading of "I
     * do not know" is to let it through: silence would be indistinguishable
     * from a suite that never finished, which is the one failure mode of a
     * notification filter nobody can debug.
     */
    const m = await load();
    expect(m.ciShouldNotify({})).toBe(true);
  });
});

describe("with the setting off", () => {
  it("lets everything through", async () => {
    const m = await load();
    m.setCiOnlyApproved(false);
    expect(m.ciOnlyApproved()).toBe(false);
    expect(m.ciShouldNotify({ approved: false })).toBe(true);
    expect(m.ciShouldNotify({ approved: true })).toBe(true);
  });

  it("survives a reload, and turning it back on does too", async () => {
    (await load()).setCiOnlyApproved(false);
    expect((await load()).ciOnlyApproved()).toBe(false);
    (await load()).setCiOnlyApproved(true);
    // The reason the reader looks at the raw string: `Boolean("0")` is true and
    // an absent key and a stored "false" both read as falsy through a cast, so
    // a naive reader makes one of these two unreachable.
    expect((await load()).ciOnlyApproved()).toBe(true);
  });
});
