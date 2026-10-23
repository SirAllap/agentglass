/*
 * The decisions behind a plugin card, pulled out of the screen (there is no
 * renderer here): which band leads, which button is filled, what a folded
 * permissions block says.
 */
import { describe, expect, test } from "bun:test";
import { cardBand, pageSummary, permissionChips, primaryAction, versionChip } from "../src/lib/pluginCard.ts";

const ok = { enabled: true, running: true, approvedFingerprint: "a", fingerprint: "a" };

describe("which band leads a card", () => {
  test("an unapproved or changed plugin asks before anything else", () => {
    expect(cardBand({ ...ok, approvedFingerprint: null, enabled: false, running: false }, true)).toBe("approval");
    expect(cardBand({ ...ok, approvedFingerprint: "old" }, false)).toBe("approval");
  });
  test("switched on and not running is a failure, ahead of an update", () => {
    expect(cardBand({ ...ok, running: false }, true)).toBe("stopped");
  });
  test("a healthy plugin shows an update only when there is one", () => {
    expect(cardBand(ok, true)).toBe("update");
    expect(cardBand(ok, false)).toBeNull();
    expect(cardBand({ ...ok, enabled: false, running: false }, false)).toBeNull();
  });
});

describe("the one filled button", () => {
  const c = { enabled: true, hasPanel: true, hasSettings: true };
  test("follows the band", () => {
    expect(primaryAction("approval", c)).toBe("review");
    expect(primaryAction("stopped", c)).toBe("settings");
    expect(primaryAction("stopped", { ...c, hasSettings: false })).toBeNull();
    expect(primaryAction("update", c)).toBe("update");
  });
  test("with no band: Open when it has a panel and is on, else Settings, else nothing", () => {
    expect(primaryAction(null, c)).toBe("open");
    expect(primaryAction(null, { ...c, enabled: false })).toBe("settings");
    expect(primaryAction(null, { enabled: true, hasPanel: false, hasSettings: false })).toBeNull();
  });
});

describe("the folded permissions summary", () => {
  test("scope, network, reads and runs counts", () => {
    const sandbox = { network: "internet", read: ["/home/me/.config/acme", "/home/me/.bun"], write: [], programs: ["gh"] } as never;
    expect(permissionChips({ scope: "read", sandbox })).toEqual(["read scope", "internet", "reads 2", "runs 1"]);
  });
  test("no sandbox declared: the scope alone", () => {
    expect(permissionChips({ scope: "answer", sandbox: undefined })).toEqual(["answer scope"]);
  });
});

describe("version and page summary", () => {
  test("a commit, local, or unpinned", () => {
    expect(versionChip({ resolvedCommit: "0123456789abcdef", source: { kind: "local-path", path: "/x" } })).toBe("0123456");
    expect(versionChip({ resolvedCommit: null, source: { kind: "local-path", path: "/x" } })).toBe("local");
    expect(versionChip({ resolvedCommit: null, source: { kind: "git", url: "https://x/y", ref: null } })).toBe("unpinned");
  });
  test("zeros are left out", () => {
    expect(pageSummary(4, 1, 1)).toBe("4 installed · 1 update · 1 needs you");
    expect(pageSummary(3, 0, 0)).toBe("3 installed");
    expect(pageSummary(5, 2, 2)).toBe("5 installed · 2 updates · 2 need you");
  });
});
