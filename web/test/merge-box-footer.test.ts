/*
 * The merge box spends ONE footer row on buttons. It used to spend two: the
 * merge group on one line, update/draft/close on another underneath. A rule
 * about source is asserted against source, there being no renderer here.
 */
import { describe, expect, it } from "bun:test";

const box = await Bun.file(new URL("../src/components/MergeBox.tsx", import.meta.url)).text();
const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

describe("merge box footer", () => {
  it("draws the secondary actions and the merge group in the same row", () => {
    const at = box.indexOf("{extraNode && <div");
    const merge = box.indexOf("{showMergeRow && <span");
    expect(at).toBeGreaterThan(0);
    expect(merge).toBeGreaterThan(at);
    // No second bordered row for extraNode.
    expect(box.match(/\{extraNode && <div className="flex[^>]*style=\{\{ borderTop/g)).toBeNull();
  });

  it("does not pin draft and close to a right edge of their own", () => {
    const at = panel.indexOf("const extraNode = (");
    const end = panel.indexOf("const hasNotes", at);
    expect(panel.slice(at, end)).not.toContain('className="ml-auto flex gap-1.5"');
  });
});

describe("the rarely used actions leave the footer", () => {
  it("To draft and Close are drawn in the hero's corner, not in the footer row", () => {
    const at = panel.indexOf("const extraNode = (");
    const end = panel.indexOf("const cornerNode = (", at);
    expect(end).toBeGreaterThan(at);
    const extra = panel.slice(at, end);
    expect(extra).not.toContain("To draft");
    expect(extra).not.toContain(">Close<");
    const corner = panel.slice(end, panel.indexOf("const hasNotes", end));
    expect(corner).toContain("To draft");
    expect(corner).toContain("Close");
    expect(box).toContain("{cornerNode && <div");
    expect(box.indexOf("{cornerNode && <div")).toBeLessThan(box.indexOf("agx-mb-stages\""));
  });
  it("Close is red only on hover or focus", () => {
    expect(box).toMatch(/\.agx-mb-quiet-danger:hover[^{]*,\.agx-mb-quiet-danger:focus-visible\{color:var\(--error-ink\)/);
    expect(box).toMatch(/\.agx-mb-quiet\{[^}]*color:var\(--text3\)/);
  });
});

describe("the merge group never moves", () => {
  it("is in the footer whether or not the pull request is ready", () => {
    const at = box.indexOf("{showMergeRow && <span");
    expect(at).toBeGreaterThan(0);
    // Not behind a readiness check: it was drawn in the hero when the box turned green.
    expect(box.slice(box.lastIndexOf("\n", at), at)).not.toContain("path.ready");
    // The footer opens on `showMergeRow` alone — whatever else joins that
    // condition (a callout, the secondary buttons, the Update branch notice)
    // is OR'ed with it, never a gate in front of it.
    const footer = /\{\(([\w\s|]+)\) && \(\s*<div className="flex items-center gap-x-3/.exec(box);
    expect(footer).not.toBeNull();
    expect(footer![1].split("||").map((t) => t.trim())).toContain("showMergeRow");
    // And the notice is drawn after the merge group, on its own full-width
    // line, so it can never push the group sideways or up.
    expect(box.indexOf("{noticeNode && <div className=\"basis-full")).toBeGreaterThan(box.indexOf("{showMergeRow && <span"));
    expect(box).toContain('if (a.id === "merge") return null');
  });
  it("no hero of the model carries the merge, auto-merge or update as its action, in any state", async () => {
    const { mergePath } = await import("../../shared/mergePath.ts");
    const NOW = Date.parse("2026-09-30T12:00:00Z");
    const ok: any[] = [{ name: "build", workflow: "CI", state: "success", done: true, required: true }];
    const run = { name: "build", workflow: "CI", state: "pending", done: false, required: true, startedAt: new Date(NOW - 30_000).toISOString() };
    const g: any = { permission: "WRITE", canBypass: false, protectionVisible: true, locked: false, approvals: 1, codeOwners: false, lastPushApproval: false, dismissStale: false, conversationResolution: false, upToDate: false, signatures: false, deployments: [], requiredContexts: [], mergeQueue: false, inQueue: false };
    const b = { state: "OPEN", mergeState: "CLEAN", baseRefName: "main", now: NOW, gate: g, checksAll: ok, reviewDecision: "APPROVED" };
    const states = [
      b, { ...b, mergeState: "BEHIND", behind: 4 }, { ...b, mergeState: "BEHIND", behind: 4, gate: { ...g, upToDate: true } },
      { ...b, mergeState: "BLOCKED", checksAll: [run] }, { ...b, mergeState: "BLOCKED", viewerDidAuthor: true, checksAll: [run], autoArmed: true },
    ];
    for (const st of states) {
      const h = mergePath(st as any).hero;
      for (const a of [h.primary, h.secondary, h.also]) expect(["merge", "arm-auto", "update-branch"]).not.toContain(a?.id ?? "");
    }
  });
});
