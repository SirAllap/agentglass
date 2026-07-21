import { beforeAll, beforeEach, describe, expect, it } from "bun:test";

/**
 * When to show the release notes, and — the part that matters — when not to.
 *
 * A modal that greets a fresh install with notes for the version it just chose,
 * or congratulates someone on a build they deliberately rolled back from, is
 * noise. Both cases still record the version, so they resolve rather than
 * repeat.
 */
let wn: typeof import("../src/lib/whatsNew.ts");
const mem = new Map<string, string>();

beforeAll(async () => {
  // Assigned, not defaulted: another suite installs its own stub at module
  // scope, and `??=` silently left this file writing into theirs — green alone,
  // red in the full run.
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
  };
  wn = await import("../src/lib/whatsNew.ts");
});

beforeEach(() => mem.clear());

const seen = () => mem.get("agentglass_seen_release") ?? null;

describe("what's new", () => {
  it("announces a version newer than the one last seen", () => {
    expect(wn.releaseToAnnounce("v0.4.0", "v0.3.0")).toBe("v0.4.0");
  });

  it("stays silent on a first run, and records it", () => {
    // Nothing seen before is a fresh install or the first launch after this
    // shipped. Neither is "what changed since last time".
    expect(wn.releaseToAnnounce("v0.4.0", "")).toBeNull();
    expect(seen()).toBe("v0.4.0");
  });

  it("stays silent on the same version", () => {
    expect(wn.releaseToAnnounce("v0.4.0", "v0.4.0")).toBeNull();
  });

  it("stays silent on a downgrade, and records where we now are", () => {
    // Rolling back is deliberate; being told what is new in the build you just
    // left is nonsense. Recording it means the next upgrade announces again.
    expect(wn.releaseToAnnounce("v0.3.0", "v0.4.0")).toBeNull();
    expect(seen()).toBe("v0.3.0");
  });

  it("compares numerically, so v0.10.0 beats v0.9.0", () => {
    // The one comparison that has to survive a year of releases.
    expect(wn.releaseToAnnounce("v0.10.0", "v0.9.0")).toBe("v0.10.0");
    expect(wn.releaseToAnnounce("v0.9.0", "v0.10.0")).toBeNull();
  });

  it("does nothing at all without a tag", () => {
    // A build that descends from no release has nothing to announce, and must
    // not poison the record with an empty version.
    expect(wn.releaseToAnnounce("", "v0.4.0")).toBeNull();
    expect(seen()).toBeNull();
  });

  it("marks a version seen on demand, for notes that failed to load", () => {
    // An empty modal on every launch would be worse than no modal, so the
    // component records the version even when it cannot show anything.
    wn.markSeen("v0.4.0");
    expect(seen()).toBe("v0.4.0");
    expect(wn.releaseToAnnounce("v0.4.0")).toBeNull();
  });
});
