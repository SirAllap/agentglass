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

/**
 * The notes About offers, which is a different question: not "has this changed
 * since last launch" but "what is in the thing I am running".
 */
describe("notes on demand", () => {
  it("offers the release this build came from", () => {
    expect(wn.installedNotes("v0.4.0", 0, "v0.4.0")).toEqual({ tag: "v0.4.0", title: "What's new", footnote: undefined });
  });

  it("admits when the build is past the tag it is named after", () => {
    // The whole reason this is not just `tag`: notes for v0.4.0 shown against a
    // build 72 commits past it describe a fraction of what is running.
    const t = wn.installedNotes("v0.4.0", 72, "v0.4.0");
    expect(t?.tag).toBe("v0.4.0");
    expect(t?.footnote).toContain("72 commits past v0.4.0");
  });

  it("counts one commit in the singular", () => {
    expect(wn.installedNotes("v0.4.0", 1, "v0.4.0")?.footnote).toContain("1 commit past");
  });

  it("falls back to the newest published release when the build descends from none", () => {
    // A dev checkout. There is nothing truthful to say about this build, so the
    // latest release is offered as itself rather than as yours.
    expect(wn.installedNotes("", 0, "v0.4.0")).toEqual({ tag: "v0.4.0", title: "Latest release" });
  });

  it("offers nothing when there is no release to point at", () => {
    // No tag published anywhere: a button here could only ever open an error.
    expect(wn.installedNotes("", 0, "")).toBeNull();
  });

  it("never offers the latest release as the installed one", () => {
    // Being on v0.3.0 with v0.4.0 published must show v0.3.0 — the button sits
    // beside the version, and showing someone else's notes there is a lie.
    expect(wn.installedNotes("v0.3.0", 0, "v0.4.0")?.tag).toBe("v0.3.0");
  });
});
