import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { UpdateStatus } from "../../shared/types.ts";

// updateStore reaches api.ts, which reads `location` at module scope, and it
// persists the announced tag — so both browser globals are stood up first.
let store: typeof import("../src/lib/updateStore.ts");
let notifyHistory: typeof import("../src/lib/sysNotify.ts")["notifyHistory"];
const mem = new Map<string, string>();
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage ??= {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
  };
  store = await import("../src/lib/updateStore.ts");
  ({ notifyHistory } = await import("../src/lib/sysNotify.ts"));
});

/**
 * Background update checks.
 *
 * The badge is a standing state; the note is an interruption. Those are
 * different lifetimes and the difference is the whole design: a release stays
 * available until you take it, but being told about it twice is nagging.
 */
const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  ok: true,
  available: true,
  info: { version: "0.3.0", commit: "abc1234", builtAt: "", source: "", origin: "https://example.com/x.git", baseTag: "v0.3.0", distance: 3 },
  branch: "v0.3.1",
  behind: 1,
  ahead: 0,
  incoming: [{ sha: "deadbee", subject: "fix the thing" }],
  ...over,
});

// The note history is app-wide and additive across tests, so every assertion
// about it is a delta rather than an absolute count.
const notesForUpdate = () => notifyHistory().filter((n) => n.app === "update");

beforeEach(() => store.__resetUpdateStore());

describe("update store", () => {
  it("raises the badge for a newer release", () => {
    store.ingestUpdate(status());
    expect(store.updateAvailable()).toBe(true);
    expect(store.updateState()?.branch).toBe("v0.3.1");
  });

  it("stays quiet when this build is already newest", () => {
    const before = notesForUpdate().length;
    store.ingestUpdate(status({ behind: 0, branch: "v0.3.0" }));
    expect(store.updateAvailable()).toBe(false);
    expect(notesForUpdate().length).toBe(before);
  });

  it("treats a blocked check as no news rather than as an update", () => {
    // "no releases published yet" and "this build records no origin" are honest
    // refusals. Badging them would send someone to a button that cannot run.
    const before = notesForUpdate().length;
    store.ingestUpdate(status({ blocked: "no releases published yet" }));
    expect(store.updateAvailable()).toBe(false);
    expect(notesForUpdate().length).toBe(before);
  });

  it("announces a tag once, however often it is seen", () => {
    const before = notesForUpdate().length;
    store.ingestUpdate(status());
    store.ingestUpdate(status());
    store.ingestUpdate(status());
    expect(notesForUpdate().length - before).toBe(1);
  });

  it("announces again when a newer tag arrives", () => {
    const before = notesForUpdate().length;
    store.ingestUpdate(status());
    store.ingestUpdate(status({ branch: "v0.4.0", behind: 2 }));
    expect(notesForUpdate().length - before).toBe(2);
  });

  it("keeps the badge up across a restart it does not re-announce", () => {
    // The persisted memory is about the note only. A restart must still show
    // the badge, or the update becomes invisible again — which is the bug.
    store.ingestUpdate(status());
    const seen = notesForUpdate().length;
    __resetUpdateStoreExceptMemory();
    store.ingestUpdate(status());
    expect(store.updateAvailable()).toBe(true);
    expect(notesForUpdate().length).toBe(seen);
  });

  it("does not retract what it knows when a check fails", () => {
    // ingest(null) is not "no update available", it is "we could not ask".
    store.ingestUpdate(status());
    store.ingestUpdate(null);
    expect(store.updateAvailable()).toBe(false);
    expect(store.updateState()).toBeNull();
  });

  it("tells subscribers only when the answer moves", () => {
    let calls = 0;
    const off = store.subscribeUpdate(() => { calls++; });
    store.ingestUpdate(status());
    const afterFirst = calls;
    store.ingestUpdate(status());       // same answer
    expect(calls).toBe(afterFirst);
    store.ingestUpdate(status({ branch: "v0.4.0", behind: 2 }));
    expect(calls).toBe(afterFirst + 1);
    off();
  });
});

/** Drop the in-memory snapshot the way a page reload would, while leaving the
 *  persisted "already announced" memory in place. */
function __resetUpdateStoreExceptMemory(): void {
  const remembered = localStorage.getItem("agentglass_update_announced");
  store.__resetUpdateStore();
  if (remembered) localStorage.setItem("agentglass_update_announced", remembered);
}
