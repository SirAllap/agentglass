/*
 * The merge buttons live in the dock at the bottom of the detail, on every tab,
 * not in the Overview's box. The box keeps the verdict, the four things in the
 * way, the notes and the Update branch notice. A rule about source is asserted
 * against source, there being no renderer here.
 */
import { describe, expect, it } from "bun:test";

const box = await Bun.file(new URL("../src/components/MergeBox.tsx", import.meta.url)).text();
const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const between = (from: string, to: string) => { const a = panel.indexOf(from); return panel.slice(a, panel.indexOf(to, a)); };

describe("the merge box no longer holds buttons", () => {
  it("takes no merge, auto-merge, branch-move or corner nodes", () => {
    for (const k of ["mergeNode", "autoNode", "updateNode", "cornerNode", "showMergeRow"]) expect(box).not.toContain(k);
    expect(box).toContain("noticeNode");
  });
  it("branch moves are still not repeated in the hero", () => {
    expect(box).toContain("if (actionInFooter(a.id)) return null");
  });
});

describe("the dock", () => {
  const dock = between("function PrDock(", "\n}\n");
  it("holds merge, the reason, the branch moves (update, resolve, terminal) and To draft / Close, in that order", () => {
    const order = ["{mergeNode}", "reason.text", "{updateNode}{conflictNode}", "{autoNode}", "{cornerNode}"].map((k) => dock.indexOf(k));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("is drawn after the tab body, so it is on every tab", () => {
    expect(panel.indexOf("<PrDock band={band} />")).toBeGreaterThan(panel.indexOf("</CommitJumpCtx.Provider>"));
  });
  it("To draft and Close are not in the branch-move row", () => {
    const extra = between("const updateNode = (", "const cornerNode = (");
    expect(extra).not.toContain("To draft");
    expect(extra).not.toContain(">Close<");
    const corner = between("const cornerNode = (", "const hasNotes");
    expect(corner).toContain("To draft");
    expect(corner).toContain('tone="danger"');
  });
  it("the merge group is drawn whether or not the pull request is ready, and over a conflict it is off, not gone", () => {
    const merge = between("const mergeNode = (", "const autoNode = (");
    expect(merge).not.toContain("!conflicted && (");
    expect(between("const mergeDisabled =", "const mergeNode").includes("conflicted")).toBe(true);
  });
});

describe("the merge group never moves", () => {
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
