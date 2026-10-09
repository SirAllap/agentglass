/*
 * A watch the person armed by hand fired, CI passed, the button turned "CI
 * passed" and nothing else happened: the notification centre had "Quiet on",
 * which holds back the toast, the badge and the sound of everything the app
 * volunteers. This one was asked for, so Quiet does not apply to it, and the
 * button says plainly what happened and goes back to "Notify" once seen.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { PrWatch } from "../../shared/types.ts";

const cell = new Map<string, string>();
let sys: typeof import("../src/lib/sysNotify.ts");
let store: typeof import("../src/lib/prWatchStore.ts");
let policy: typeof import("../src/lib/notePolicy.ts");

beforeAll(async () => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null, setItem: (k: string, v: string) => { cell.set(k, v); }, removeItem: (k: string) => { cell.delete(k); },
  };
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  sys = await import("../src/lib/sysNotify.ts");
  store = await import("../src/lib/prWatchStore.ts");
  policy = await import("../src/lib/notePolicy.ts");
});
beforeEach(() => { cell.clear(); sys.clearNotes(); });

const fired = (o: Partial<PrWatch> = {}): PrWatch =>
  ({ id: "1", repo: "acme/orbit", number: 1042, rule: { type: "ci-pass" }, active: false, lastAt: new Date(2026, 8, 30, 10, 42).getTime(), lastText: "CI passed", ...o });

describe("Quiet does not hold back what was asked for", () => {
  test("the policy interrupts and badges an asked note with Quiet on", () => {
    const s = { muted: new Set<string>(), quiet: true };
    expect(policy.deliveryFor({ app: "agentglass", urgency: 1, source: "ci" }, s)).toMatchObject({ interrupt: false });
    expect(policy.deliveryFor({ app: "agentglass", urgency: 1, source: "ci", asked: true }, s)).toEqual({ keep: true, badge: true, interrupt: true });
  });

  test("a fired watch shows a toast with Quiet on, and leaves an unread row", () => {
    sys.setNotifyQuiet(true);
    const toasts: any[] = [];
    const off = sys.subscribeAskedFires((t) => toasts.push(t));
    sys.fireWatchAlert({ seq: 901, repo: "acme/orbit", number: 1042, title: "Add thing", summary: "CI passed", detail: "71 checks", ok: true });
    off();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ ok: true, title: "CI passed — #1042" });
    expect(sys.notifyUnread()).toBe(1);
    expect(sys.notifyHistory()[0]).toMatchObject({ asked: true });
  });
});

describe("the button after a fire", () => {
  test("says what happened and when, then goes back to Notify once seen", () => {
    const w = fired();
    expect(store.bellState([w], 0).kind).toBe("fired");
    expect(store.firedLabel(w)).toBe("CI passed · 10:42");
    expect(store.firedLabel(fired({ lastText: "CI failed: unit" }))).toBe("CI failed · 10:42");
    expect(store.firedOk(w)).toBe(true);
    expect(store.firedOk(fired({ lastText: "CI failed: unit" }))).toBe(false);
    expect(store.bellState([w], w.lastAt!).kind).toBe("off");
    // a later fire is a new thing to see
    expect(store.bellState([fired({ lastAt: w.lastAt! + 60_000 })], w.lastAt!).kind).toBe("fired");
  });

  test("dismissal is remembered per pull request", () => {
    store.markFireSeen("acme/orbit", 1042, 500);
    expect(store.fireSeenAt("acme/orbit", 1042)).toBe(500);
    expect(store.fireSeenAt("acme/orbit", 7)).toBe(0);
  });
});
