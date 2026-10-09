import { describe, expect, it } from "bun:test";
import {
  actionTarget, checkFacts, tookLabel,
  alertPayload, oneLine, primaryAction, secondaryAction, targetLabel, watchPayload, askedAlertKey,
} from "../../shared/notifyPayload.ts";
import { gotoOfTarget } from "../src/lib/notifyRoute.ts";

/*
 * What a notification says and where it leads, decided without a renderer.
 * Names are invented (acme/orbit, ORBIT-1042).
 */
const fire = { repo: "acme/orbit", number: 1042, title: "ORBIT-1042 add thing to the weekly report", summary: "CI passed", detail: "" };

describe("watchPayload", () => {
  it("title is the verdict then the object, with no app prefix", () => {
    const p = watchPayload(fire);
    expect(p.title).toBe("CI passed · acme/orbit #1042");
    expect(p.title).not.toMatch(/agentglass/i);
  });
  it("a pass with nothing to add reads as the PR's own title, never the verdict again", () => {
    const p = watchPayload(fire);
    expect(p.line).toBe("ORBIT-1042 add thing to the weekly report");
    expect(p.line).not.toContain("CI passed");
  });
  it("a failure's line is the failing checks, which is the one fact that matters", () => {
    const p = watchPayload({ ...fire, summary: "CI failed", detail: "e2e, lint, unit +2 more" });
    expect(p.title).toBe("CI failed · acme/orbit #1042");
    expect(p.line).toBe("e2e, lint, unit +2 more");
  });
  it("carries the PR as its target and as its primary action", () => {
    const p = watchPayload(fire);
    expect(p.target).toEqual({ kind: "pr", repo: "acme/orbit", number: 1042 });
    expect(primaryAction(p)).toEqual({ label: "Open PR", target: p.target! });
    expect(secondaryAction(p)).toBeNull();
    expect(p.actions!.length).toBeLessThanOrEqual(2);
  });
  it("a long comment is cut to one line", () => {
    const p = watchPayload({ ...fire, summary: "New comment", detail: "first line\n\n" + "word ".repeat(60) });
    expect(p.line.includes("\n")).toBe(false);
    expect(p.line.length).toBeLessThanOrEqual(90);
    expect(p.line.endsWith("…")).toBe(true);
  });
});

describe("the facts behind a verdict", () => {
  const run = (start: string, end: string) => ({ startedAt: `2026-10-06T10:${start}:00Z`, completedAt: `2026-10-06T10:${end}:00Z` });
  it("counts what passed, skipped and failed, and how long the longest run took", () => {
    expect(checkFacts({ success: 49, failure: 0, skipped: 13 }, [run("00", "12")])).toEqual(["49 passed", "13 skipped", "took 12m"]);
    expect(checkFacts({ success: 46, failure: 3, skipped: 0 }, [])).toEqual(["46 passed", "3 failed"]);
  });
  it("says nothing it does not know", () => {
    expect(checkFacts(undefined, undefined)).toEqual([]);
    expect(tookLabel(45_000)).toBe("45s");
    expect(tookLabel(65 * 60_000)).toBe("1h 5m");
  });
  it("a passed run carries them and a single action; a failed one names the count and offers the re-run", () => {
    const pass = watchPayload(fire, { root: "/x/orbit", checks: { success: 49, failure: 0, skipped: 13 }, all: [run("00", "12")] });
    expect(pass.facts).toEqual(["49 passed", "13 skipped", "took 12m"]);
    expect(pass.actions).toHaveLength(1);
    const bad = watchPayload({ ...fire, summary: "CI failed", detail: "e2e, lint, unit", ok: false }, { root: "/x/orbit", checks: { success: 46, failure: 3, skipped: 0 } });
    expect(bad.line).toBe("3 failed: e2e, lint, unit");
    expect(bad.actions!.map((a) => a.label)).toEqual(["Open checks", "Re-run failed"]);
    expect(actionTarget(bad.actions![0]!)).toEqual(bad.target!);
    expect(bad.actions![1]).toEqual({ label: "Re-run failed", run: "rerun-failed", root: "/x/orbit", number: 1042 });
    expect(actionTarget(bad.actions![1]!)).toBeNull();
  });
  it("without the checkout there is no re-run to offer, and never a Merge", () => {
    const bad = watchPayload({ ...fire, summary: "CI failed", detail: "unit", ok: false });
    expect(bad.actions!.map((a) => a.label)).toEqual(["Open checks"]);
    expect(JSON.stringify(bad)).not.toMatch(/merge/i);
  });
});

describe("alertPayload", () => {
  it("an agent alert leads to its pane", () => {
    const p = alertPayload({ title: "orbit-api: Bash needs you", body: "rm -rf build/", pane: "%12" });
    expect(p.target).toEqual({ kind: "pane", pane: "%12" });
    expect(primaryAction(p)!.label).toBe("Open terminal");
  });
  it("without a pane there is nothing to press", () => {
    const p = alertPayload({ title: "Tool error", body: "exit 1" });
    expect(p.target).toBeUndefined();
    expect(primaryAction(p)).toBeNull();
  });
  it("a body that only repeats the title is dropped", () => {
    expect(alertPayload({ title: "Turn finished", body: "Turn finished" }).line).toBe("");
  });
});

describe("targets", () => {
  it("every kind has a button that says where it goes", () => {
    expect(targetLabel({ kind: "file", root: "/x/orbit", path: "docs/report.md" })).toBe("Open file");
    expect(targetLabel({ kind: "card", id: "abc", label: "ORBIT-1042" })).toBe("Open card");
    expect(targetLabel({ kind: "url", url: "https://example.com" })).toBe("Open link");
  });
  it("every kind the app has a view for routes in-app; only a bare link has no destination", () => {
    expect(gotoOfTarget({ kind: "pr", repo: "acme/orbit", number: 1 })).toEqual({ kind: "pr", repo: "acme/orbit", number: 1 });
    expect(gotoOfTarget({ kind: "pane", pane: "%3" })).toEqual({ kind: "pane", pane: "%3" });
    expect(gotoOfTarget({ kind: "file", root: "/x/orbit", path: "a/b.md" })).toEqual({ kind: "file", root: "/x/orbit", path: "a/b.md" });
    expect(gotoOfTarget({ kind: "card", id: "abc", label: "ORBIT-1042" })).toEqual({ kind: "card", id: "abc", label: "ORBIT-1042" });
    expect(gotoOfTarget({ kind: "url", url: "https://example.com" })).toBeNull();
  });
  it("oneLine leaves a short text alone", () => { expect(oneLine("  a   b ", 10)).toBe("a b"); });
  it("the event key is the PR, the head and the verdict", () => {
    const k = askedAlertKey({ repo: "acme/orbit", number: 7, sha: "abc", verdict: "pass" });
    expect(k).toBe("acme/orbit#7@abc:pass");
    expect(askedAlertKey({ repo: "acme/orbit", number: 7, sha: "def", verdict: "pass" })).not.toBe(k);
  });
});
